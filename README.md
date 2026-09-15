# Mock API — dokumentacja

Lokalny MockServer na `http://localhost:1080`, używany jako SUT w ćwiczeniach z Bruno.

```bash
npm install
npm start          # start (wymaga Javy 11+)
npm run mock:stop  # awaryjne zatrzymanie, gdy port 1080 został zajęty
```

Dashboard z podglądem żądań na żywo: <http://localhost:1080/mockserver/dashboard>

> Wszystko, co nie pasuje do żadnego expectation, dostaje **404** od samego MockServera — bez ciała w formacie API. To nie jest odpowiedź aplikacji, tylko „nie znam takiego endpointu”.

---

## Konta testowe

| username | password | rola |
|---|---|---|
| `ada` | `password123` | `admin` |
| `linus` | `password123` | `user` |

---

## Autoryzacja

### `POST /auth/token`

Wymienia dane logowania na token. Body: `{"username": "...", "password": "..."}`.

| Status | Kiedy | Ciało |
|---|---|---|
| 200 | poprawne dane | `{"tokenType":"Bearer","accessToken":"tok_...","expiresIn":3600,"role":"admin"}` |
| 401 | złe dane | `{"error":"Invalid credentials"}` |
| 400 | body puste lub niepoprawny JSON | `{"error":"Request body is malformed JSON"}` |

### `GET /me`

Wymaga nagłówka `Authorization: Bearer <accessToken>`.

| Status | Kiedy | Ciało |
|---|---|---|
| 200 | ważny token | `{"id":1,"username":"ada","firstName":"Ada","lastName":"Lovelace","role":"admin"}` |
| 401 | brak / nieznany / wycofany token | `{"error":"Missing or invalid access token"}` + nagłówek `WWW-Authenticate` |

### `POST /auth/logout`

Wymaga tokenu. Zwraca **204 bez ciała** i unieważnia token — kolejne `GET /me` z tym tokenem daje 401.

### `POST /auth/login-cookie`

Body `{"username":"ada","password":"password123"}` → 200 + nagłówek `Set-Cookie: sessionId=sess-8f3c-ada`.

### `GET /auth/whoami`

Czyta ciasteczko `sessionId` (klient HTTP odsyła je sam). 200 z profilem albo 401 `{"error":"Missing or invalid session cookie"}`.

---

## Produkty

Stan trzymany w pamięci procesu — `POST`, `PUT` i `DELETE` **naprawdę** zmieniają to, co zwróci kolejny `GET`. Dane startowe: 6 produktów w kategoriach `peryferia`, `monitory`, `akcesoria`.

### `GET /api/products`

Publiczny (bez tokenu). Parametry zapytania:

| Parametr | Dozwolone wartości | Domyślnie |
|---|---|---|
| `category` | `peryferia` \| `monitory` \| `akcesoria` | brak filtra |
| `inStock` | `true` \| `false` | brak filtra |
| `sort` | `id`, `name`, `price`, z prefiksem `-` = malejąco | `id` |
| `page` | liczba całkowita ≥ 1 | `1` |
| `pageSize` | liczba całkowita 1–50 | `3` |

200:

```json
{ "items": [ … ], "page": 1, "pageSize": 3, "total": 6, "totalPages": 2 }
```

Strona poza zakresem → 200 z pustą listą `items` (nie 404).

400 przy złym parametrze:

```json
{ "error": "Invalid query parameter",
  "details": [ { "param": "page", "message": "Must be an integer >= 1, got \"0\"" } ] }
```

### `GET /api/products/:id`

| Status | Kiedy |
|---|---|
| 200 | produkt istnieje |
| 400 | `:id` nie jest liczbą — `{"error":"Product id must be a number, got \"abc\""}` |
| 404 | `{"error":"Product 999 not found"}` |

### `POST /api/products`

Wymaga tokenu (dowolna rola). Body:

```json
{ "name": "Lampka biurkowa", "category": "akcesoria", "price": 89.9, "inStock": true }
```

Reguły: `name` — tekst ≥ 3 znaki; `category` — jedna z trzech dozwolonych; `price` — liczba > 0, maks. 2 miejsca po przecinku; `inStock` — opcjonalny boolean (domyślnie `true`).

| Status | Kiedy | Uwagi |
|---|---|---|
| 201 | utworzono | nagłówek `Location: /api/products/7`, w ciele nowy produkt z nadanym `id` |
| 401 | brak/nieważny token | |
| 422 | body poprawne składniowo, dane błędne | `{"error":"Validation failed","details":[{"field":"price","message":"…"}]}` |
| 400 | body nie jest poprawnym JSON-em | rozróżnienie 400 vs 422 jest celowe |

### `PUT /api/products/:id`

Wymaga tokenu. **Pełne nadpisanie** — payload musi zawierać wszystkie pola, te same reguły co przy `POST`. Zwraca 200 / 401 / 404 / 422.

### `DELETE /api/products/:id`

Wymaga tokenu **roli `admin`**.

| Status | Kiedy |
|---|---|
| 204 | usunięto (brak ciała) |
| 401 | brak tokenu |
| 403 | token użytkownika `linus` — `{"error":"Requires role: admin"}` |
| 404 | produkt nie istnieje |

### `POST /api/reset`

Przywraca 6 produktów startowych i zeruje licznik `/api/rate-limited`. 200 `{"reset":true,"products":6,"rateLimitHits":0}`. Nie unieważnia wydanych tokenów.

---

## Przypadki brzegowe

| Endpoint | Zachowanie |
|---|---|
| `GET /api/slow` | odpowiada 200 po ok. **2 sekundach** |
| `GET /api/rate-limited` | pierwsze 3 wywołania → 200 + `X-RateLimit-Remaining`; kolejne → **429** + `Retry-After: 2` |
| `GET /api/status/:code` | zwraca dowolny trzycyfrowy status, np. `/api/status/503`; dla 204 i 304 bez ciała |
| `GET /api/report.csv` | 200 z `Content-Type: text/csv; charset=utf-8` i `Content-Disposition` — odpowiedź **nie jest JSON-em** |

---

## Endpointy z pierwszych zajęć (bez zmian)

| Endpoint | Odpowiedź |
|---|---|
| `GET /helloWorld` | 200 `{"message":"Hello World"}` — ścieżka jest case-sensitive |
| `POST /login` | 200 `{"firstName":"Mateusz","lastName":"Wyczawski"}` dla JSON `foo`/`bar`, inaczej 404 |
| `POST /validate-file` | multipart, pole `file`; 200 z `rowCount`/`rows` albo 400 z listą `details` |

---

## Struktura kodu

| Plik | Za co odpowiada |
|---|---|
| `server.js` | rejestracja wszystkich expectations |
| `auth.js` | użytkownicy, tokeny, ciasteczko sesyjne, odpowiedzi 401/403 |
| `products.js` | dane produktów, filtrowanie/sortowanie/paginacja, walidacja |
| `request-utils.js` | odczyt query string, ciasteczek, body i segmentu ścieżki w callbacku |
| `multipart.js` | ręczny parser `multipart/form-data` (MockServer go nie ma) |
| `csv.js` | walidacja CSV dla `/validate-file` |
