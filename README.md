# personal-claude-code-dashboard

[personal-claude-code v2](https://github.com/sideholic/personal-claude-code-v2) 플러그인의 티켓을 실시간으로 보여주는 보드. 플러그인이 기록하는 `.claude-team/events.jsonl`을 읽어 칸반(queue → in-progress → in-review → done)으로 렌더링한다.

## 실행 (로컬)

```bash
pnpm install
EVENTS_LOG=/절대경로/대상프로젝트/.claude-team/events.jsonl pnpm dev
# http://localhost:4317
```

`EVENTS_LOG`을 지정하지 않으면 `../personal-claude-code-v2/.claude-team/events.jsonl`을 기본으로 읽는다.

## 실행 (Docker)

```bash
docker build -t claude-board .
docker run -p 4317:4317 \
  -v /절대경로/대상프로젝트/.claude-team/events.jsonl:/data/events.jsonl:ro \
  claude-board
```

## 환경변수

| 변수 | 설명 | 기본값 |
|---|---|---|
| `EVENTS_LOG` | 읽을 `events.jsonl` 절대경로 | `../personal-claude-code-v2/.claude-team/events.jsonl` |
| `PORT` | 서버 포트 | `4317` |

## 스택

Next.js 16 (App Router) · React 19 · TypeScript · SSE.
