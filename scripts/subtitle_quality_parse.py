"""Read-only subtitle decoding and parsing for the quality audit.

Only text tracks are supported. An encoding label containing ``ambiguous``
means both legacy Korean/Japanese decoders accepted the input; callers should
review that file before making a destructive decision. No replacement decoding
is used. Cue times are seconds; MicroDVD frame times are unknown without FPS.
"""

from __future__ import annotations

import codecs
import html
from html.parser import HTMLParser
import re


def _validate_text(text: str) -> None:
    if "\x00" in text:
        raise ValueError("NUL bytes indicate binary data or an unsupported encoding")
    controls = sum((ord(c) < 32 and c not in "\n\r\t\f") or 0x7f <= ord(c) <= 0x9f for c in text)
    if controls:
        raise ValueError("Subtitle contains binary control characters")
    if "\ufffd" in text:
        raise ValueError("Subtitle already contains Unicode replacement characters")


def _language_score(text: str) -> float:
    hangul = sum("\uac00" <= c <= "\ud7a3" for c in text)
    kana = sum("\u3040" <= c <= "\u30ff" for c in text)
    half_kana = sum("\uff61" <= c <= "\uff9f" for c in text)
    ideographs = sum("\u3400" <= c <= "\u9fff" for c in text)
    punctuation = sum(c in "、。『』「」！？" for c in text)
    # Full-width kana plus kanji form stronger evidence than accidental Hangul.
    # Half-width kana frequently arise when CP949 is incorrectly read as CP932.
    return max(hangul * 2.0, kana * 4.0 + min(ideographs, kana * 3) * 0.5) + punctuation - half_kana


def decode_subtitle(data: bytes) -> tuple[str, str]:
    """Decode strictly, returning text and an auditable encoding label."""
    if not isinstance(data, bytes):
        raise TypeError("decode_subtitle expects bytes")
    for bom, encoding in (
        (codecs.BOM_UTF32_LE, "utf-32"),
        (codecs.BOM_UTF32_BE, "utf-32"),
        (codecs.BOM_UTF8, "utf-8-sig"),
        (codecs.BOM_UTF16_LE, "utf-16"),
        (codecs.BOM_UTF16_BE, "utf-16"),
    ):
        if data.startswith(bom):
            try:
                text = data.decode(encoding, errors="strict")
            except UnicodeDecodeError as exc:
                raise ValueError(f"Invalid {encoding} subtitle") from exc
            _validate_text(text)
            return text, encoding
    try:
        text = data.decode("utf-8", errors="strict")
        _validate_text(text)
        return text, "utf-8"
    except (UnicodeDecodeError, ValueError):
        pass
    if b"\x00" in data:
        # BOM-less UTF-16 must show the expected ASCII markup/timecode pattern.
        # Binary VobSub and other opaque input are deliberately not guessed.
        if len(data) >= 8 and len(data) % 2 == 0:
            zeros_even = data[0::2].count(0) / (len(data) / 2)
            zeros_odd = data[1::2].count(0) / (len(data) / 2)
            encoding = "utf-16-le" if zeros_odd > zeros_even else "utf-16-be"
            if max(zeros_even, zeros_odd) > 0.2 and min(zeros_even, zeros_odd) < 0.05:
                try:
                    text = data.decode(encoding, errors="strict")
                    _validate_text(text)
                    if re.search(r"-->|<sync\b|\[events\]|\{\d+\}\{\d+\}", text, re.I):
                        return text, encoding + " (inferred)"
                except (UnicodeDecodeError, ValueError):
                    pass
        raise ValueError("Binary subtitle or unsupported BOM-less Unicode encoding")
    candidates: list[tuple[str, str]] = []
    for encoding in ("cp949", "cp932"):
        try:
            text = data.decode(encoding, errors="strict")
            _validate_text(text)
            candidates.append((text, encoding))
        except (UnicodeDecodeError, ValueError):
            continue
    if not candidates:
        raise ValueError("Cannot strictly decode subtitle as UTF-8, CP949, or CP932")
    if len(candidates) == 1 or candidates[0][0] == candidates[-1][0]:
        return candidates[0]
    candidates.sort(key=lambda item: _language_score(item[0]), reverse=True)
    text, encoding = candidates[0]
    return text, f"{encoding} (ambiguous: {candidates[1][1]})"


class _TextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.parts: list[str] = []
        self.hidden = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "head"}:
            self.hidden += 1
        elif not self.hidden and tag in {"br", "p", "div"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "head"}:
            self.hidden = max(0, self.hidden - 1)
        elif not self.hidden and tag in {"p", "div"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.hidden:
            self.parts.append(data)

    def handle_entityref(self, name: str) -> None:
        self.handle_data(html.unescape("&" + name + ";"))

    def handle_charref(self, name: str) -> None:
        self.handle_data(html.unescape("&#" + name + ";"))


def _clean_text(value: str, ass: bool = False) -> str:
    # ASS overrides also occur in SRT. Drawing payload is not spoken text.
    pieces: list[str] = []
    drawing = False
    for piece in re.split(r"(\{[^{}]*\})", value):
        if piece.startswith("{") and piece.endswith("}") and "\\" in piece:
            commands = re.findall(r"\\p(\d+)\b", piece)
            if commands:
                drawing = int(commands[-1]) != 0
            continue
        if not drawing:
            pieces.append(piece)
    value = "".join(pieces)
    value = re.sub(r"<\d+:\d{2}(?::\d{2})?\.\d{3}>", "", value)
    if ass:
        value = value.replace(r"\N", "\n").replace(r"\n", "\n").replace(r"\h", " ")
    parser = _TextParser()
    parser.feed(value)
    parser.close()
    value = "".join(parser.parts).replace("\u00a0", " ").replace("\ufeff", "")
    return "\n".join(" ".join(line.split()) for line in value.splitlines()).strip()


_STAMP = r"\d{1,}:\d{2}(?::\d{2})?[,.]\d{1,3}"
_TIMING = re.compile(rf"^\s*({_STAMP})\s*-->\s*({_STAMP})(?:\s+.*)?\s*$")


def _time(value: str) -> float:
    value = value.strip().replace(",", ".")
    parts = value.split(":")
    if len(parts) not in (2, 3):
        raise ValueError(f"Invalid subtitle timestamp: {value!r}")
    try:
        seconds = float(parts[-1])
        minutes = int(parts[-2])
        hours = int(parts[0]) if len(parts) == 3 else 0
    except ValueError as exc:
        raise ValueError("Invalid numeric subtitle timestamp") from exc
    if hours < 0 or minutes < 0 or (len(parts) == 3 and minutes >= 60) or not 0 <= seconds < 60:
        raise ValueError(f"Out-of-range subtitle timestamp: {value!r}")
    return hours * 3600 + minutes * 60 + seconds


def _cue(start: float, end: float | None, text: str, track: str = "") -> dict:
    if end is not None and end < start:
        raise ValueError("Subtitle cue ends before it starts")
    return {"start": start, "end": end, "text": text, "track": track}


def _parse_timed(text: str, vtt: bool) -> list[dict]:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if vtt:
        # Metadata blocks can contain arrows and numbers which are not cues.
        filtered: list[str] = []
        skip = False
        for line in lines:
            if re.match(r"^(NOTE(?:\s|$)|STYLE\s*$|REGION\s*$|WEBVTT(?:\s|$))", line):
                skip = True
            if not line.strip():
                skip = False
                filtered.append("")
            elif not skip:
                filtered.append(line)
        lines = filtered
    for line in lines:
        if re.match(r"^\s*\d+:\d{2}.*-->", line) and not _TIMING.match(line):
            raise ValueError("Malformed subtitle cue timestamp line")
    matches = [(i, _TIMING.match(line)) for i, line in enumerate(lines) if _TIMING.match(line)]
    if not matches:
        if vtt and text.lstrip("\ufeff \r\n\t").startswith("WEBVTT"):
            return []
        raise ValueError("No recognizable subtitle cue timestamps")
    first_line = matches[0][0]
    indexed_srt = not vtt and first_line > 0 and lines[first_line - 1].strip().isdigit()
    result: list[dict] = []
    for n, (line_no, match) in enumerate(matches):
        assert match is not None
        stop = matches[n + 1][0] if n + 1 < len(matches) else len(lines)
        body = lines[line_no + 1:stop]
        if n + 1 < len(matches) and len(body) >= 2:
            # In an indexed SRT lacking blank separators, discard the next
            # cue's index. A lone number is dialogue and must stay intact.
            if body[-1].strip().isdigit() and (indexed_srt or any(not x.strip() for x in body[:-1])):
                body.pop()
        # Blank lines terminate cue payload. In VTT, any remaining line is the
        # next cue's optional identifier, not subtitle content.
        for i, line in enumerate(body):
            if not line.strip():
                body = body[:i]
                break
        cleaned = _clean_text("\n".join(body))
        if cleaned:
            result.append(_cue(_time(match[1]), _time(match[2]), cleaned))
    return result


def _parse_ass(text: str) -> list[dict]:
    fields = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"]
    section = ""
    recognized = False
    result: list[dict] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped.lower()
            if section in {"[events]", "[script info]"}:
                recognized = True
            continue
        if section != "[events]":
            continue
        prefix, separator, payload = stripped.partition(":")
        if not separator:
            continue
        if prefix.lower() == "format":
            fields = [part.strip().lower() for part in payload.split(",")]
            if not all(name in fields for name in ("start", "end", "text")) or len(fields) != len(set(fields)):
                raise ValueError("Invalid ASS Events Format fields")
        elif prefix.lower() == "dialogue":
            text_index = fields.index("text")
            before = payload.lstrip().split(",", text_index)
            if len(before) != text_index + 1:
                raise ValueError("Truncated ASS Dialogue fields")
            trailing = len(fields) - text_index - 1
            after = before[-1].rsplit(",", trailing) if trailing else [before[-1]]
            values = before[:-1] + after
            if len(values) != len(fields):
                raise ValueError("Truncated ASS Dialogue fields")
            event = dict(zip(fields, values))
            cleaned = _clean_text(event["text"], ass=True)
            if cleaned:
                result.append(_cue(_time(event["start"]), _time(event["end"]), cleaned, event.get("style", "").strip()))
    if not recognized:
        raise ValueError("Missing ASS/SSA subtitle sections")
    return result


class _SamiParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.start: float | None = None
        self.track = ""
        self.parts: list[str] = []
        self.pending: list[dict] = []
        self.result: list[dict] = []
        self.hidden = 0
        self.sync_count = 0
        self.recognized = False

    def flush_text(self) -> None:
        cleaned = _clean_text("".join(self.parts))
        if self.start is not None and cleaned:
            self.pending.append(_cue(self.start, None, cleaned, self.track))
        self.parts = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag == "sami":
            self.recognized = True
        if tag in {"head", "style", "script"}:
            self.hidden += 1
            return
        if self.hidden:
            return
        if tag == "sync":
            self.recognized = True
            self.flush_text()
            raw = attributes.get("start", "") or ""
            if not re.fullmatch(r"\d+(?:\.\d+)?", raw.strip()):
                raise ValueError("Invalid SAMI SYNC start time")
            new_start = float(raw) / 1000
            for item in self.pending:
                item["end"] = new_start
                if new_start < item["start"]:
                    raise ValueError("SAMI SYNC timestamps are out of order")
                self.result.append(item)
            self.pending = []
            self.start = new_start
            self.track = ""
            self.sync_count += 1
        elif tag == "p":
            self.flush_text()
            self.track = attributes.get("class", "") or ""
        elif self.start is not None:
            self.parts.append(self.get_starttag_text() or "")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"head", "style", "script"}:
            self.hidden = max(0, self.hidden - 1)
        elif not self.hidden and tag == "p":
            self.flush_text()
        elif not self.hidden and self.start is not None:
            self.parts.append(f"</{tag}>")

    def handle_data(self, data: str) -> None:
        if not self.hidden and self.start is not None:
            self.parts.append(data)

    def handle_entityref(self, name: str) -> None:
        self.handle_data("&" + name + ";")

    def handle_charref(self, name: str) -> None:
        self.handle_data("&#" + name + ";")

    def finish(self) -> list[dict]:
        self.flush_text()
        self.result.extend(self.pending)
        if not self.recognized:
            raise ValueError("Missing SAMI/SYNC subtitle structure")
        return self.result


def _parse_microdvd(text: str) -> list[dict]:
    result: list[dict] = []
    fps: float | None = None
    recognized = False
    for line in text.splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r"\s*\{(\d+)\}\{(\d+)\}(.*)", line)
        if not match:
            raise ValueError("Unsupported textual .sub format (expected MicroDVD)")
        recognized = True
        first, last = int(match[1]), int(match[2])
        if last < first:
            raise ValueError("MicroDVD cue ends before its starting frame")
        if not result and first == last and first in (0, 1) and re.fullmatch(r"\d+(?:\.\d+)?", match[3].strip()):
            candidate = float(match[3])
            if 1 <= candidate <= 240:
                fps = candidate
                continue
        payload = re.sub(r"\{[yYfFsScChHoOpP]:[^}]*\}", "", match[3]).replace("|", "\n")
        cleaned = _clean_text(payload)
        if cleaned:
            # Unknown frame rate must not be guessed for time-weighted scoring.
            result.append(_cue(first / fps if fps else 0.0, last / fps if fps else None, cleaned))
    if not recognized:
        raise ValueError("No MicroDVD subtitle cues")
    return result


def parse_subtitle(text: str, extension: str) -> list[dict]:
    """Parse supported text subtitles into normalized, nonempty cue records."""
    _validate_text(text)
    text = text.lstrip("\ufeff")
    extension = extension.lower().lstrip(".")
    if extension not in {"srt", "vtt", "ass", "ssa", "smi", "sami", "sub"}:
        raise ValueError(f"Unsupported subtitle extension: {extension}")
    if not text.strip():
        return []
    if extension in {"srt", "vtt"}:
        return _parse_timed(text, vtt=extension == "vtt")
    if extension in {"ass", "ssa"}:
        return _parse_ass(text)
    if extension in {"smi", "sami"}:
        parser = _SamiParser()
        parser.feed(text)
        parser.close()
        return parser.finish()
    return _parse_microdvd(text)
