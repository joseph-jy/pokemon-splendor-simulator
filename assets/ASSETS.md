# 이미지 리소스 규칙 및 매니페스트

## 디렉토리 구조
```
assets/
├── balls/      # 몬스터볼 이미지 (128×128)
├── stage1/     # 1단계 카드 포켓몬 (256×256)
├── stage2/     # 2단계 카드 포켓몬 (256×256)
├── stage3/     # 3단계 카드 포켓몬 (256×256)
├── rare/       # 희귀/전설/환상 포켓몬 (256×256)
└── ui/         # UI 요소 (아이콘, 배경 등)
```

## 파일명 규칙
 - **포맷**: PNG (투명 배경)
 - **파일명**: 영문 소문자 romanization (예: `charizard.png`)
 - **크기**: 카드 256×256, 볼 128×128 (UI는 용도별)
 - **이름 정규화**: 공백/하이픈 없음, 단일 단어 (PokéAPI species명 기준)

> 동일 포켓몬이 여러 단계에 등장하지 않으므로 충돌 없음. 진화 사슬은 각 단계 디렉토리에 별개 파일 (예: `stage1/charmander.png`, `stage2/charmeleon.png`, `stage3/charizard.png`).

## 매니페스트 (코드 참조용)
 `data` 모듈에서 `assets/<dir>/<romanized>.png` 경로로 직접 참조. 별도 매핑 테이블 불필요 (파일명 = 식별자).

### 볼 (balls/)
 | 한국어 | 파일명 | 컬러 |
 |---|---|---|
 | 몬스터볼 | monsterball.png | 레드 |
 | 슈퍼볼 | superball.png | 블루 |
 | 하이퍼볼 | hyperball.png | 블랙 |
 | 힐볼 | healball.png | 핑크 |
 | 퀵볼 | quickball.png | 옐로 |
 | 마스터볼 | masterball.png | (특수) |

### 희귀/전설/환상 (rare/)
 | 한국어 | 파일명 | 등급 |
 |---|---|---|
 | 라플라스 | lapras.png | 희귀 |
 | 메타몽 | ditto.png | 희귀 |
 | 프테라 | aerodactyl.png | 희귀 |
 | 잠만보 | snorlax.png | 희귀 |
 | 이브이 | eevee.png | 희귀 |
 | 썬더 | zapdos.png | 전설 |
 | 뮤 | mew.png | 전설 |
 | 프리져 | articuno.png | 전설 |
 | 파이어 | moltres.png | 환상 |
 | 뮤츠 | mewtwo.png | 환상 |

### 1단계 (stage1/)
 파이리(charmander) · 이상해씨(bulbasaur) · 꼬부기(squirtle) · 케이시(abra) · 미뇽(dratini) · 꼬마돌(geodude) · 고오스(gastly) · 알통몬(machop) · 캐터피(caterpie) · 뿔충이(weedle) · 구구(pidgey) · 니드런(nidoran) · 모다피(bellsprout) · 발챙이(poliwag) · 뚜벅초(oddish)

### 2단계 (stage2/)
 리자드(charmeleon) · 이상해풀(ivysaur) · 어니부기(wartortle) · 윤겔라(kadabra) · 신뇽(dragonair) · 데구리(graveler) · 고우스트(haunter) · 근육몬(machoke) · 단데기(metapod) · 딱충이(kakuna) · 피죤(pidgeotto) · 니드리나(nidorina) · 우츠동(weepinbell) · 슈륙챙이(poliwhirl) · 냄새꼬(gloom)

### 3단계 (stage3/)
 리자몽(charizard) · 이상해꽃(venusaur) · 거북왕(blastoise) · 후딘(alakazam) · 망나뇽(dragonite) · 딱구리(golem) · 팬텀(gengar) · 괴력몬(machamp) · 버터플(butterfree) · 독침붕(beedrill) · 피죤투(pidgeot) · 니드퀸(nidoqueen) · 우츠보트(victreebel) · 강챙이(poliwrath) · 라플레시아(vileplume)

## 현재 상태
 모든 파일은 **투명 placeholder PNG** (유효하지만 빈 이미지). 실제 이미지로 교체 시 같은 파일명·같은 디렉토리에 덮어쓰면 코드 수정 불필요.

## 이미지 교체 시 체크리스트
 - [ ] PNG 투명 배경 (알파 채널)
 - [ ] 카드 256×256, 볼 128×128 권장 (CSS로 스케일링되므로 비율만 맞으면 됨)
 - [ ] 파일명 동일 유지 (romanization)
 - [ ] 저작권/라이선스 확보 (포켓몬 컴퍼니 자산은 비상업적 팬 용도만 허용)
