# 수협 차량 운행기록

강사 휴대폰 한 대로 실제 GPS 운행을 기록합니다.

1. 휴대폰 브라우저에서 https://hosang78.github.io/gps/ 에 접속합니다.
2. 차량을 선택하고 **운행 시작**을 누른 뒤 브라우저 위치 권한을 허용합니다.
3. 휴대폰에서 처음 받은 유효 위치에 지도가 열립니다. 이후 5초마다 새로운 위치가 있는지 확인합니다.
4. **운행 종료**를 누르면 기기 브라우저에 운행일지가 저장됩니다. 일지를 눌러 지도에서 기록을 확인할 수 있습니다.

카카오맵은 설정에 기존 JavaScript 키를 넣어 사용합니다. 지도 설정의 **서버 기록 연결**은 선택 사항입니다. 기존 접근 코드를 입력한 경우, 서버에 있는 기록을 조회하고 새 기록을 30초 단위로 서버에도 보낼 수 있습니다. 지도 키와 접근 코드는 소스 파일에 포함하지 않습니다.

## 배포 및 API

- GitHub Pages 배포 경로는 `main` 브랜치의 `/docs`입니다.
- `api/schema.sql`의 테이블은 Neon 프로젝트 sh의 fleet-demo 브랜치, fleet_demo 데이터베이스 전용입니다.
- `api/index.mjs`는 @neondatabase/serverless를 포함해 Node.js 24 대상 ESM으로 번들링한 뒤 index.mjs 이름으로 ZIP에 담아 Neon Function으로 배포합니다.
- 서버 환경 변수 FLEET_DATABASE_URL에는 제한된 DB 계정의 연결 문자열을, FLEET_CODE_HASHES에는 접근 코드의 SHA-256 해시를 쉼표로 구분해 넣습니다.
- `docs/config.js`에는 공개 API URL만 저장합니다.
