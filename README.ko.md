# climanager-session

[English README](README.md) · 데모 영상: _준비 중_ <!-- TODO: site URL -->

코딩 에이전트가 [CLI Manager](https://github.com/woorichicken/CLI_manager) 안에 **눈에 보이는** 터미널 세션을 열고,
거기서 다른 에이전트를 돌리고, 끝날 때까지 기다렸다가 화면을 읽게 해 주는 스킬입니다. 사용자는 같은 터미널을
보면서 언제든 직접 입력하거나 AI 연결을 끊을 수 있습니다.

```bash
npx skills add woorichicken/climanager-session@climanager-session
```

## 이렇게 말하면 됩니다

- "`~/code/api` 를 CLI Manager 에서 Claude Code 로 열고 실패하는 테스트 고치라고 해줘"
- "패키지마다 세션 하나씩 세 개 열고, 끝나는 대로 알려줘"
- "아까 연 세션 끝났어? 지금 뭐 하고 있어?"

## 설치부터 첫 세션까지

1. **CLI Manager v1.10.0 이상**(macOS) 설치 — [최신 릴리스](https://github.com/woorichicken/CLI_manager/releases/latest).
   API 는 v1.9.0 부터 있고, v1.10.0 에서 부하 중 입력 유실과 입력창 추천 문구 구분이 고쳐졌습니다.
2. 앱에서 **Settings › Agents › AI Control API** 켜기. `~/.climanager/control-api.json`(주소·토큰, 권한 600,
   앱 종료 시 삭제)이 생기고 `127.0.0.1:47821` 에서 대기합니다.
3. 스킬 설치: 위 명령(모든 프로젝트에 쓰려면 `-g`).
4. 연결 확인(Node 18+):
   ```bash
   CLI=~/.claude/skills/climanager-session/scripts/clim.mjs   # Claude Code + -g 기준
   node "$CLI" doctor       # OK  CLI Manager 1.10.0 …
   node "$CLI" templates
   ```
5. 첫 세션:
   ```bash
   node "$CLI" open ~/code/my-project --template claude-code --prompt "failing test 를 고쳐줘"
   node "$CLI" wait last --timeout 300
   node "$CLI" release last
   ```

## 내 프로세스로 만들어 쓰기

이 스킬은 **엔진**입니다 — 열고, 입력하고, 기다리고, 읽습니다. 어떤 프로젝트를 돌릴지, 에이전트가
어디까지 혼자 배포해도 되는지, 어디서 멈추고 물어야 하는지, 아침에 무엇을 보고 싶은지 같은
**프로세스**는 사람마다 다릅니다. 그건 이 스킬을 부르는 **자기만의 스킬**로 만드세요.
[`references/process-template.md`](references/process-template.md)에서 시작하면 됩니다.
이미 두세 번 반복한 일부터 케이스로 옮기세요 — 한 번도 안 돌려 본 프로세스는 추측입니다.

## 종료 코드

| 코드 | 뜻 | 다음 |
| --- | --- | --- |
| 0 | 성공 | 계속 |
| 1 | 기타 API 오류 | 메시지 확인 |
| 2 | 사용법 오류 | 인자 수정 |
| 3 | 화면에 질문·메뉴 | `read` 후 `--keys` 로 답하기 |
| 4 | 세션 없음 / 사용자가 회수 | 그 세션 사용 중단 |
| 5 | API 꺼짐·앱 없음 | 2단계 확인 |
| 7 | 대기 시간 초과 — 아직 실행 중 | 다시 `wait` (실패 아님) |

## MCP 로 쓰기

Settings › Agents 에서 토큰이 들어간 명령을 그대로 복사합니다.

```bash
claude mcp add --scope user --transport http cli-manager http://127.0.0.1:47821/mcp \
  --header "Authorization: Bearer <token>"
```

## 문제 해결

| 증상 | 조치 |
| --- | --- |
| `doctor` 가 5 | 앱 실행 + AI Control API 켜기 |
| Settings 에 항목이 없음 | CLI Manager 업데이트 |
| `terminal not started` | 앱 창 열기 |
| `first prompt NOT sent` | 폴더 신뢰 등 질문 중 — `read` → `--keys` → `send` |
| 프롬프트가 입력창에 남아 있음 | `send <세션> --keys enter` |

자세한 내용은 [English README](README.md) 와 [SKILL.md](SKILL.md) 를 보세요. 라이선스: [MIT](LICENSE).
