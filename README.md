# Trace

정리하려 애쓰지 않고 생각을 던져두는 local-first AI Working Memory 데스크톱 앱입니다.

## 실행

```bash
npm install
npm run desktop:dev
```

기본 단축키는 Windows `Ctrl + ;`, macOS `Cmd + ;` 입니다.

## MVP 원칙

- 원문은 SQLite에 즉시 저장합니다.
- AI가 꺼져 있어도 로컬 규칙으로 태그와 카테고리를 추정합니다.
- 네트워크 장애가 기록을 막지 않습니다.
- 외부 AI provider 호출과 동기화는 데이터가 쌓인 뒤 추가합니다.

상세 설계는 [docs/PRODUCT.md](docs/PRODUCT.md)를 참고하세요.
