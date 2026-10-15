# 다운로드 검증과 실행 차단 제보

[공식 GitHub 릴리스](https://github.com/DarkVideoManager/DarkVideoManager/releases/latest)에서 앱과 **같은 버전**의 `SHA256SUMS.txt`, `VERIFICATION.md`를 받습니다. 설치형은 `Setup`, 설치 없이 실행하는 파일은 `Portable`입니다. `VERIFICATION.md`에는 해당 배포에서 실제로 확인한 범위가 기록됩니다.

## 파일이 공식 배포본과 같은지 확인

Windows PowerShell에서 받은 파일의 SHA-256을 확인합니다. 파일 이름과 폴더는 실제 다운로드 위치에 맞춥니다.

```powershell
Get-FileHash -LiteralPath 'C:\Downloads\DarkVideoManager-Portable-0.2.4-x64.exe' -Algorithm SHA256
```

출력의 `Hash`를 같은 릴리스의 `SHA256SUMS.txt`에서 **같은 파일 이름** 옆에 있는 값과 비교합니다. 해시의 영문 대소문자는 구분하지 않습니다. 파일이 변경되면 해시도 달라집니다. [Microsoft Get-FileHash 안내](https://learn.microsoft.com/powershell/module/microsoft.powershell.utility/get-filehash)

2026-10-15에 [v0.2.4 공식 SHA256SUMS.txt](https://github.com/DarkVideoManager/DarkVideoManager/releases/download/v0.2.4/SHA256SUMS.txt)와 GitHub 릴리스 자산의 digest를 대조한 기준값은 다음과 같습니다. 다른 버전에는 해당 버전의 기준값을 사용합니다. 이 표는 공개된 기준값을 확인한 기록이며, 차단을 제보한 파일을 직접 검사한 결과는 아닙니다.

| v0.2.4 파일                               | SHA-256                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `DarkVideoManager-Portable-0.2.4-x64.exe` | `ec36e45f4957fde2c170c99feaa1f24f033ad957b98b646931fb9413d8cbfcc4` |
| `DarkVideoManager-Setup-0.2.4-x64.exe`    | `0fc580fa6a57d7c2dd936dae80e2c33b22a3b6dfce493e2188c951222d4f9300` |

소스를 받은 경우 검증 도우미로 선택한 파일 하나를 자동 대조할 수 있습니다. 릴리스의 다른 파일을 모두 내려받을 필요는 없습니다.

```powershell
powershell -NoProfile -File .\scripts\verify-release.ps1 -FilePath 'C:\Downloads\DarkVideoManager-Portable-0.2.4-x64.exe' -ChecksumFile 'C:\Downloads\SHA256SUMS.txt'
```

도우미는 파일을 읽어 해시와 Windows 서명 상태를 표시하며 실행하지 않습니다. 목록의 형식·파일 이름이 잘못됐거나 해시가 다르면 실패합니다. 해시가 일치한다는 것은 공식 목록에 적힌 파일과 바이트가 같다는 뜻이며, 악성 여부나 백신의 탐지 결과를 판정하지 않습니다.

## Windows 서명 상태 확인

```powershell
Get-AuthenticodeSignature -LiteralPath 'C:\Downloads\DarkVideoManager-Portable-0.2.4-x64.exe' | Format-List Status,StatusMessage,SignerCertificate
```

`Valid`이면 서명 인증서의 발급 대상도 확인합니다. `NotSigned`는 서명이 없다는 상태입니다. 서명 유무만으로 악성 여부를 판단하지 않습니다. 저장소의 배포 후보 빌드는 코드 서명을 자동 적용하지 않으므로, 실제로 받은 파일의 결과를 기록합니다. [Microsoft 서명 확인 안내](https://learn.microsoft.com/powershell/module/microsoft.powershell.security/get-authenticodesignature)

## V3 등에서 차단한 경우

차단 기록에서 **어떤 파일을 어떤 탐지명으로 차단했는지** 먼저 확인합니다. 포터블 EXE 자체인지, 압축을 푼 앱이나 포함 도구인지에 따라 확인할 대상 파일이 달라집니다. V3의 진단 로그·파일 분석 보고서에서 상세 내용을 확인할 수 있습니다. [AhnLab 진단 로그 안내](https://help.ahnlab.com/V3_IS_90/ko_kr/v3_report.htm)

다음 정보를 [이슈](https://github.com/DarkVideoManager/DarkVideoManager/issues)로 남기면 같은 대상을 조사할 수 있습니다. 개인 계정명과 경로, 다른 파일 목록 등은 가리고 필요한 부분만 공유합니다.

- 앱 버전, 설치형/포터블 구분, 받은 공식 릴리스 주소
- 차단된 파일 이름과 SHA-256(파일이 남아 있어 확인할 수 있는 경우)
- V3 제품·버전·진단 정의 버전, 정확한 탐지명과 탐지 시각
- 다운로드·실행·압축 해제·자막 도구 설치 중 어느 단계에서 차단됐는지
- Windows 버전과 필요한 부분만 남긴 차단 기록

해시가 다르면 받은 버전과 파일 이름을 다시 확인하고 같은 공식 릴리스에서 다시 받습니다. 같아도 탐지가 발생하면 그 사실과 탐지 정보를 기록합니다. 정상 파일 오탐 여부는 백신 업체의 분석 결과가 필요합니다. [AhnLab 오탐 안내](https://ask.ahnlab.com/hc/ko/articles/900002412366)와 [신고 방법](https://ask.ahnlab.com/hc/ko/articles/900003237626)에 따라 정확히 탐지된 파일과 기록으로 분석을 요청할 수 있습니다. 제출에는 해당 파일을 공유할 권한이 필요하므로 개인 영상·자막·설정·API 키를 함께 보내지 않습니다.

#13 제보에는 버전·파일 해시·탐지명·차단 기록이 없어 현재 오탐 또는 차단 원인을 판정할 수 없습니다. 위 절차는 증거를 확인하기 위한 안내이며 V3 재검증 완료나 차단 해제를 뜻하지 않습니다.
