import { describe, expect, it, vi } from 'vitest'

vi.mock('../store/libraryStore', () => ({ useLibraryStore: vi.fn() }))
import { parseSubtitleCues } from '../components/player/VideoPlayer.jsx'

describe('generated subtitle text', () => {
  it('decodes SRT entities once while preserving literal markup as plain cue text', () => {
    const result = parseSubtitleCues(
      '1\n00:00:01,250 --> 00:00:03,000\nA &amp; B &lt;script&gt; &quot;quote&quot; &#39; &#x1F600; &amp;lt;\n',
    )
    expect(result).toEqual([
      {
        startSec: 1.25,
        endSec: 3,
        text: 'A & B <script> "quote" \' 😀 &lt;',
      },
    ])
  })

  it('keeps invalid and unknown entities intact without failing the entire subtitle file', () => {
    const result = parseSubtitleCues(
      'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n&#0; &#xD800; &#1114112; &unknown;\n\n00:00:01.000 --> 00:00:02.000\n안녕하세요\n',
    )
    expect(result.map((cue) => cue.text)).toEqual([
      '&#0; &#xD800; &#1114112; &unknown;',
      '안녕하세요',
    ])
  })
})
