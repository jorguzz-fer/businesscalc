# BusinessCalc — Plano de Implementação SaaS

> **Status**: Planejamento aprovado, aguardando início da Fase 0.
> **Branch de desenvolvimento**: `claude/continue-businesscalc-Uk8Mb`
> **Última atualização**: 2026-04-14

---

## Contexto

O BusinessCalc nasceu como SPA estática (`index.html` + nginx) com calculadoras financeiras e, na iteração mais recente, dashboards DRE/FC gerados via upload XLSX com dados salvos em `localStorage`. O P.O. aprovou a direção e pediu a evolução para **SaaS multi-tenant** com:

1. Registro/login de usuários
2. Banco de dados (dados ficam no servidor, não mais no navegador)
3. Pacote de segurança robusto (dados financeiros = sensíveis)
4. Histórico arquivado para comparações período-a-período e KPI/metas ao longo do tempo
5. Entrada manual campo-a-campo (complementar ao upload XLSX)

Este plano cobre **todas as fases** do MVP até o SaaS completo, com foco em qualidade, segurança e entrega incremental.

---

## Arquitetura

```
┌─────────────────────────────────────────────────┐
│                 Coolify (VPS)                   │
│                                                 │
│  ┌──────────────┐         ┌──────────────┐      │
│  │   app        │────────▶│  postgres    │      │
│  │ Node+Fastify │         │  (volume)    │      │
│  │ serve HTML + │         └──────────────┘      │
│  │ API /api/*   │                               │
│  └──────────────┘         ┌──────────────┐      │
│         │                 │  backups     │      │
│         ▼                 │  (volume)    │      │
│  ┌──────────────┐         └──────────────┘      │
│  │  Traefik     │                               │
│  │  TLS auto    │                               │
│  └──────────────┘                               │
└─────────────────────────────────────────────────┘
         ▲
         │ HTTPS
         │
    ┌────┴────┐
    │ Browser │
    └─────────┘

External services:
- Resend (SMTP transacional)
```

### Estrutura de repositório (após migração)

```
/
├── Dockerfile                 # build da app Node
├── docker-compose.yml         # dev local (app + postgres)
├── .env.example               # template de env vars (sem secrets)
├── .dockerignore
├── package.json
├── tsconfig.json
├── PLAN.md                    # este arquivo
├── README.md
├── prisma/
│   ├── schema.prisma          # modelo de dados
│   └── migrations/            # migrations versionadas
├── src/
│   ├── index.ts               # bootstrap
│   ├── server.ts              # setup Fastify (plugins, hooks)
│   ├── config.ts              # env vars tipadas (zod)
│   ├── db.ts                  # Prisma client singleton
│   ├── middleware/
│   │   ├── requireAuth.ts
│   │   ├── csrfProtect.ts
│   │   ├── rateLimit.ts
│   │   └── auditLog.ts
│   ├── routes/
│   │   ├── auth.ts            # /api/auth/*
│   │   ├── periods.ts         # /api/periods/*
│   │   ├── entries.ts         # /api/periods/:id/entries
│   │   └── uploads.ts         # /api/periods/:id/upload
│   ├── services/
│   │   ├── auth.service.ts    # signup/login/session/reset
│   │   ├── email.service.ts   # Resend wrapper
│   │   ├── xlsx.service.ts    # parse/gen template
│   │   └── audit.service.ts
│   ├── schemas/               # zod schemas
│   │   ├── auth.schema.ts
│   │   └── period.schema.ts
│   └── utils/
│       ├── password.ts        # argon2id hash/verify
│       ├── tokens.ts          # CSRF token, reset token
│       └── crypto.ts          # encrypt/decrypt sensitive fields
├── public/
│   ├── login.html
│   ├── signup.html
│   ├── reset.html
│   ├── verify.html
│   ├── app.html               # ← index.html atual migrado
│   └── assets/
│       └── ... (fonts, favicon, logo)
└── tests/
    ├── setup.ts               # testcontainers postgres
    ├── auth.test.ts
    ├── periods.test.ts
    ├── security.test.ts       # CSRF, IDOR, XSS
    └── fixtures/
```

---

## Stack

| Camada         | Escolha                              | Por quê                                                                       |
|----------------|--------------------------------------|-------------------------------------------------------------------------------|
| Runtime        | Node.js 20 LTS                       | Footprint baixo, ecossistema maduro                                            |
| Framework      | Fastify 4                            | Mais rápido que Express, plugins oficiais de segurança                         |
| Language       | TypeScript 5                         | Type-safety end-to-end; reduz bugs em produção                                 |
| ORM            | Prisma 5                             | Queries parametrizadas nativas (zero SQL injection), migrations versionadas    |
| DB             | PostgreSQL 16                        | Padrão ouro, FK, constraints, backup incremental                               |
| Auth           | Custom (argon2id + session cookie)   | Controle total, zero lock-in                                                   |
| Validation     | zod                                  | Schemas tipados, integra com TS                                                |
| Email          | Resend                               | DX moderno, DKIM/SPF auto, 3k/mês free                                        |
| Frontend       | HTML + vanilla JS (mantido)          | Evita retrabalho; app atual já aprovado pelo P.O.                              |
| Charts         | Chart.js 4 (mantido)                 | Já integrado                                                                   |
| XLSX           | SheetJS 0.18 (mantido)               | Já integrado; cuidar de XXE (ver Security Baseline)                            |
| Tests          | Vitest + Supertest + Testcontainers  | Testa DB real em container descartável                                         |
| Deploy         | Docker (Dockerfile) + Coolify        | Já configurado                                                                 |
| TLS            | Let's Encrypt via Traefik no Coolify | Auto, sem custo                                                                |

### Dependências npm principais (referência)

```
fastify, @fastify/cookie, @fastify/helmet, @fastify/rate-limit,
@fastify/csrf-protection, @fastify/static, @fastify/multipart,
@prisma/client, prisma,
argon2, zod, resend, xlsx, pino
vitest, supertest, @testcontainers/postgresql (dev)
```

---

## Security Baseline (vibesec-derived) — LEITURA OBRIGATÓRIA

Esta seção define o piso de segurança para **todo código** do projeto. Cada tarefa deve revisar os itens aplicáveis.

### 1. Access Control

- [ ] **UUID v4** em todos os IDs expostos (`users`, `periods`, `sessions` — nunca sequencial)
- [ ] **Ownership check** em toda rota autenticada: `resource.userId === session.userId` (antes de ler/editar/deletar)
- [ ] **404 em vez de 403** quando o recurso existe mas não pertence ao usuário (previne enumeração)
- [ ] **Mass assignment**: rotas PUT/PATCH usam zod schema com campos explicitamente permitidos — nunca `prisma.update({ data: req.body })` direto
- [ ] **Session revogável**: tabela `sessions` permite invalidar por `logout`, `delete account`, ou revogação por admin

### 2. XSS

- [ ] Todo valor vindo do usuário ou DB é renderizado com `textContent`, não `innerHTML`
- [ ] CSP estrito:
  ```
  Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self';
  ```
- [ ] Headers adicionais: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`
- [ ] Filenames sanitizados antes de armazenar (strip `< > " ' &`)

### 3. CSRF

- [ ] Todo endpoint `POST/PUT/PATCH/DELETE` protegido por CSRF token
- [ ] Estratégia **double-submit cookie**: token em cookie + header `X-CSRF-Token`, server valida que batem
- [ ] Cookie de sessão: `httpOnly; Secure; SameSite=Strict`
- [ ] Token regenerado no login e no reset de senha
- [ ] Login endpoint protegido (previne login CSRF)

### 4. Secrets

- [ ] **Zero secrets** no repo. `.env` fora do git, `.env.example` documenta variáveis (sem valores reais)
- [ ] Secrets via Coolify env vars: `DATABASE_URL`, `SESSION_SECRET`, `RESEND_API_KEY`, `ENCRYPTION_KEY`
- [ ] `SESSION_SECRET`: 64 bytes aleatórios (`openssl rand -hex 64`)
- [ ] `ENCRYPTION_KEY`: 32 bytes (AES-256-GCM) para colunas sensíveis futuramente

### 5. File Upload (XLSX)

- [ ] Validação de extensão (`.xlsx`)
- [ ] Validação de MIME (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`)
- [ ] Validação de **magic bytes** (`50 4B 03 04` — ZIP/XLSX)
- [ ] Tamanho máximo: 10 MB hard-cap no Fastify multipart
- [ ] Nome do arquivo **nunca** usado como path; UUID gerado server-side
- [ ] Arquivo processado em memória, não salvo em disco
- [ ] **XXE**: SheetJS internamente parseia XML. Configurar `{ dense: true, cellDates: false, cellFormula: false, cellHTML: false, bookVBA: false }` e rejeitar arquivos com macros/VBA

### 6. SQL Injection

- [ ] **100% Prisma** (parametrizado). Zero `$queryRawUnsafe`.
- [ ] Se precisar raw, usar `Prisma.sql` tagged template
- [ ] DB user da aplicação com least privilege (sem DROP/TRUNCATE em prod)

### 7. Password Security

- [ ] **argon2id** (mais moderno que bcrypt, recomendação OWASP 2023)
  - `memoryCost: 19456` (19 MiB), `timeCost: 2`, `parallelism: 1`
- [ ] Mínimo 12 caracteres, sem máximo (hasheia de qualquer jeito)
- [ ] Sem regras arbitrárias (sem "1 maiúscula + 1 número + 1 símbolo")
- [ ] Validar contra HIBP pwned passwords (API k-anonymity) — opcional Fase 3
- [ ] Nunca logar/exibir/retornar hash

### 8. Session

- [ ] Session ID = UUID v4 em cookie `httpOnly; Secure; SameSite=Strict; Max-Age=604800` (7 dias)
- [ ] Tabela `sessions` com `expiresAt`, `userAgent`, `ip`
- [ ] Renovação de expiração em uso ativo (sliding expiration)
- [ ] Logout = `DELETE FROM sessions WHERE id = ?`
- [ ] Limite de sessões ativas por usuário: 10 (GC das mais antigas)

### 9. Rate Limiting

- [ ] `/api/auth/login`: 5 tentativas / 15 min / IP
- [ ] `/api/auth/signup`: 3 contas / hora / IP
- [ ] `/api/auth/forgot-password`: 3 requests / hora / email
- [ ] Geral autenticado: 100 req / min / user
- [ ] Geral público: 30 req / min / IP
- [ ] Account lockout: 10 falhas consecutivas = lockout 30 min

### 10. Headers (`@fastify/helmet`)

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
Content-Security-Policy: [ver seção 2]
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), camera=(), microphone=()
```

### 11. Error Handling

- [ ] Produção: mensagens genéricas (`"Erro ao processar solicitação"`)
- [ ] Stack trace só em logs server-side (nunca na response)
- [ ] Erros de auth: mesma mensagem para usuário inexistente e senha errada (`"credenciais inválidas"`)
- [ ] Log estruturado com pino; rotação automatizada

### 12. Audit Log

- [ ] Tabela `audit_logs` registra: signup, login (sucesso/falha), logout, password_reset_request, password_changed, email_changed, period.create, period.delete
- [ ] Campos: `userId`, `action`, `resource`, `ip`, `userAgent`, `metadata` (json), `createdAt`
- [ ] Nunca logar senhas, tokens, sessão
- [ ] Retenção: 2 anos

### 13. LGPD / Compliance

- [ ] Política de privacidade acessível pré-signup
- [ ] Aceite de termos explícito no signup (campo `termsAcceptedAt`)
- [ ] Direito de acesso: endpoint `/api/me/export` retorna todos os dados do usuário em JSON
- [ ] Direito de apagamento: endpoint `/api/me/delete` remove cascata (preserva `audit_logs` anonimizados por 6 meses legal)
- [ ] DPO email documentado no footer

---

## Data Model (Prisma schema)

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id                 String    @id @default(uuid())
  email              String    @unique
  passwordHash       String    @map("password_hash")
  name               String?
  emailVerified      Boolean   @default(false) @map("email_verified")
  verifyToken        String?   @unique @map("verify_token")
  verifyTokenExpires DateTime? @map("verify_token_expires")
  resetToken         String?   @unique @map("reset_token")
  resetTokenExpires  DateTime? @map("reset_token_expires")
  failedLoginCount   Int       @default(0) @map("failed_login_count")
  lockedUntil        DateTime? @map("locked_until")
  termsAcceptedAt    DateTime? @map("terms_accepted_at")
  createdAt          DateTime  @default(now()) @map("created_at")
  updatedAt          DateTime  @updatedAt @map("updated_at")
  lastLoginAt        DateTime? @map("last_login_at")

  sessions  Session[]
  periods   Period[]
  auditLogs AuditLog[]

  @@map("users")
}

model Session {
  id        String   @id @default(uuid())
  userId    String   @map("user_id")
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  csrfToken String   @map("csrf_token")
  ip        String?
  userAgent String?  @map("user_agent") @db.VarChar(512)
  expiresAt DateTime @map("expires_at")
  createdAt DateTime @default(now()) @map("created_at")
  lastUsedAt DateTime @default(now()) @map("last_used_at")

  @@index([userId])
  @@index([expiresAt])
  @@map("sessions")
}

enum PeriodType {
  DRE
  FC
}

enum PeriodStatus {
  DRAFT
  FINALIZED
}

model Period {
  id        String       @id @default(uuid())
  userId    String       @map("user_id")
  user      User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  name      String       // "DRE 2024", "Projeção 2025"
  year      Int
  type      PeriodType
  status    PeriodStatus @default(DRAFT)
  createdAt DateTime     @default(now()) @map("created_at")
  updatedAt DateTime     @updatedAt @map("updated_at")

  entries Entry[]
  meta    Meta?

  @@unique([userId, name, type])
  @@index([userId])
  @@map("periods")
}

model Entry {
  id        String   @id @default(uuid())
  periodId  String   @map("period_id")
  period    Period   @relation(fields: [periodId], references: [id], onDelete: Cascade)
  category  String   // 'receita', 'deducoes', 'cmv', ...
  monthly   Json     // [jan, fev, ..., dez] — 12 números (2 decimais)
  updatedAt DateTime @updatedAt @map("updated_at")

  @@unique([periodId, category])
  @@map("entries")
}

model Meta {
  id              String   @id @default(uuid())
  periodId        String   @unique @map("period_id")
  period          Period   @relation(fields: [periodId], references: [id], onDelete: Cascade)
  receitaAnual    Decimal? @map("receita_anual")    @db.Decimal(14, 2)
  lucroAnual      Decimal? @map("lucro_anual")      @db.Decimal(14, 2)
  margemBrutaPct  Decimal? @map("margem_bruta_pct") @db.Decimal(5, 2)
  margemOpPct     Decimal? @map("margem_op_pct")    @db.Decimal(5, 2)
  margemLiqPct    Decimal? @map("margem_liq_pct")   @db.Decimal(5, 2)
  ticketMedio     Decimal? @map("ticket_medio")     @db.Decimal(14, 2)
  pedidosMes      Int?     @map("pedidos_mes")
  updatedAt       DateTime @updatedAt @map("updated_at")

  @@map("metas")
}

model AuditLog {
  id        String   @id @default(uuid())
  userId    String?  @map("user_id")
  user      User?    @relation(fields: [userId], references: [id], onDelete: SetNull)
  action    String
  resource  String?
  ip        String?
  userAgent String?  @map("user_agent") @db.VarChar(512)
  metadata  Json?
  createdAt DateTime @default(now()) @map("created_at")

  @@index([userId, createdAt])
  @@index([action, createdAt])
  @@map("audit_logs")
}
```

---

## Fase 0 — Fundação (infra + auth)

**Objetivo**: Setup completo do backend, DB, auth básico, deploy em Coolify. Ao final: usuário pode registrar, verificar email, logar, trocar senha, deslogar. App atual continua acessível mas agora atrás de login.

**Duração estimada**: 1 sprint (5-8 dias de trabalho focado)

**Branch**: `claude/saas-fase0-fundacao`

### Task 0.1 — Scaffolding do projeto Node+TS+Fastify

**Arquivos criados:**
- `package.json`, `tsconfig.json`, `.gitignore` (atualizar), `.env.example`, `.dockerignore`
- `src/index.ts`, `src/server.ts`, `src/config.ts`
- `Dockerfile` (substitui o atual), `docker-compose.yml` (dev)

**Steps:**
- [ ] `npm init -y`; adicionar deps: `fastify @fastify/cookie @fastify/helmet @fastify/static @fastify/multipart @fastify/rate-limit @fastify/csrf-protection @fastify/formbody zod argon2 resend pino`
- [ ] Dev deps: `typescript @types/node tsx vitest supertest @testcontainers/postgresql prisma`
- [ ] `tsconfig.json` com `strict: true`, `target: ES2022`, `module: NodeNext`
- [ ] `src/config.ts`: carrega env com zod, falha se faltar var obrigatória
- [ ] `src/server.ts`: cria Fastify com helmet (CSP), rate-limit global, cookie, CSRF, pino logger
- [ ] `.env.example` com: `DATABASE_URL`, `SESSION_SECRET`, `RESEND_API_KEY`, `APP_URL`, `NODE_ENV`
- [ ] `Dockerfile` multi-stage: builder (install + prisma generate + tsc) → runner (node:20-alpine, apenas `dist/` + `node_modules/`)
- [ ] `docker-compose.yml` com `app` + `postgres:16-alpine` + volume
- [ ] Commit: `chore: scaffold node+fastify+ts backend`

### Task 0.2 — Prisma + schema inicial

**Arquivos:**
- `prisma/schema.prisma` (ver Data Model acima)
- `src/db.ts` (Prisma singleton)

**Steps:**
- [ ] `npx prisma init --datasource-provider postgresql`
- [ ] Colar schema da seção Data Model
- [ ] Subir postgres local: `docker compose up -d postgres`
- [ ] `npx prisma migrate dev --name init`
- [ ] Verificar tabelas criadas
- [ ] `src/db.ts`: exporta `prisma` singleton, reusa em hot reload
- [ ] Commit: `feat(db): initial schema with users, sessions, periods, entries, metas, audit_logs`

### Task 0.3 — Helpers de segurança

**Arquivos:**
- `src/utils/password.ts` — argon2id hash/verify
- `src/utils/tokens.ts` — random tokens (CSRF, verify, reset)
- `src/utils/crypto.ts` — AES-256-GCM stubs (usados Fase 3)

**Steps:**
- [ ] `password.ts`: `hash(plain)` e `verify(hash, plain)` usando argon2id com parâmetros OWASP
- [ ] `tokens.ts`: `generateToken(bytes=32)` via `crypto.randomBytes`, retorna base64url
- [ ] Testes unitários dos helpers (vitest)
- [ ] Commit: `feat(security): argon2id password + random token helpers`

### Task 0.4 — Zod schemas de validação

**Arquivos:**
- `src/schemas/auth.schema.ts`

**Steps:**
- [ ] `SignupSchema`: email (format), password (min 12), name (opcional, max 100), termsAccepted (true)
- [ ] `LoginSchema`: email, password
- [ ] `ForgotPasswordSchema`: email
- [ ] `ResetPasswordSchema`: token, newPassword (min 12)
- [ ] `VerifyEmailSchema`: token
- [ ] Todos rejeitam campos extras (`.strict()`)
- [ ] Commit: `feat(validation): zod schemas for auth endpoints`

### Task 0.5 — Email service (Resend)

**Arquivo:**
- `src/services/email.service.ts`

**Steps:**
- [ ] Cliente Resend instanciado via `RESEND_API_KEY`
- [ ] `sendVerifyEmail(to, token, name)`: link `${APP_URL}/verify.html?token=${token}`
- [ ] `sendResetEmail(to, token, name)`: link `${APP_URL}/reset.html?token=${token}`
- [ ] Templates HTML inline (simples, sem dependências). Plain-text fallback.
- [ ] DKIM/SPF configurados no DNS do domínio (manual, fora do código — documentar em README)
- [ ] Modo dev: se `NODE_ENV !== 'production'`, loga o link ao invés de enviar
- [ ] Commit: `feat(email): resend service with verify/reset templates`

### Task 0.6 — Auth service

**Arquivo:**
- `src/services/auth.service.ts`

**Steps:**
- [ ] `signup({ email, password, name, ip, userAgent })`:
  - checa duplicata → retorna sempre sucesso genérico (anti-enumeration)
  - hash argon2id
  - cria user com `emailVerified: false`, `verifyToken` (32 bytes) válido por 24h
  - envia email
  - loga audit: `auth.signup`
- [ ] `login({ email, password, ip, userAgent })`:
  - rate limit no route layer
  - busca user; se não existe OU senha errada → mesma resposta `"credenciais inválidas"`, incrementa `failedLoginCount`
  - se `failedLoginCount >= 10` → lock por 30 min (`lockedUntil`)
  - se `!emailVerified` → rejeita com `"verifique email primeiro"`
  - sucesso: zera `failedLoginCount`, cria session (UUID, csrfToken, 7 dias), update `lastLoginAt`
  - retorna `{ sessionId, csrfToken }`
  - loga audit: `auth.login.success` ou `auth.login.failure`
- [ ] `logout(sessionId)`: deleta session; audit `auth.logout`
- [ ] `verifyEmail(token)`: busca user com token válido, marca `emailVerified: true`, limpa token
- [ ] `forgotPassword(email)`: mesma resposta sucesso/falha (anti-enum); se existe, gera `resetToken` 1h; envia email
- [ ] `resetPassword(token, newPassword)`: valida token, troca hash, **revoga todas sessions do user**, audit `auth.password_changed`
- [ ] Commit: `feat(auth): full auth service with signup/login/verify/reset`

### Task 0.7 — Middleware `requireAuth` + CSRF

**Arquivo:**
- `src/middleware/requireAuth.ts`

**Steps:**
- [ ] Lê cookie `sid`; valida session no DB; checa `expiresAt`
- [ ] Atualiza `lastUsedAt` (sliding expiration)
- [ ] Anexa `request.user` (objeto User) e `request.session`
- [ ] Em métodos que mudam estado (POST/PUT/PATCH/DELETE): valida `X-CSRF-Token` header === `session.csrfToken`
- [ ] Falha: responde 401 (sem session) ou 403 (CSRF mismatch)
- [ ] Commit: `feat(middleware): requireAuth with session + double-submit CSRF`

### Task 0.8 — Rotas `/api/auth/*`

**Arquivo:**
- `src/routes/auth.ts`

**Steps:**
- [ ] `POST /api/auth/signup`: valida zod, chama service, retorna 201 + msg genérica
- [ ] `POST /api/auth/login`: rate-limited 5/15min/IP, chama service, seta cookie `sid` httpOnly/Secure/SameSite=Strict
- [ ] `POST /api/auth/logout`: requireAuth, deleta session, limpa cookie
- [ ] `GET /api/auth/verify?token=`: redirect pra `/login.html?verified=1`
- [ ] `POST /api/auth/forgot-password`: rate-limited 3/hour/email
- [ ] `POST /api/auth/reset-password`: valida token, troca senha
- [ ] `GET /api/auth/me`: requireAuth, retorna `{ id, email, name, csrfToken }` (sem passwordHash!)
- [ ] Registra rotas no Fastify
- [ ] Commit: `feat(routes): auth endpoints with rate limiting and CSRF`

### Task 0.9 — Páginas HTML de auth

**Arquivos:**
- `public/login.html`, `public/signup.html`, `public/reset.html`, `public/verify.html`
- `public/app.html` (renomeia index.html atual)

**Steps:**
- [ ] Reuso do CSS/fonts do app atual (tema coerente)
- [ ] `login.html`: form submit via fetch, guarda csrfToken em variável JS (sem localStorage), redireciona pra `/app.html` no sucesso
- [ ] `signup.html`: validação client-side (min 12 chars, confirma), força aceite termos
- [ ] `reset.html`: pega token da URL, form de nova senha
- [ ] `verify.html`: mensagem "email verificado, pode logar"
- [ ] `app.html` (atual `index.html`): no load, fetch `/api/auth/me` → se 401, redireciona `/login.html`
- [ ] `index.html` novo vira redirect pro `/app.html` se logado ou `/login.html` se não
- [ ] Commit: `feat(ui): login, signup, reset, verify pages`

### Task 0.10 — Static serving + CSP

**Arquivo:**
- `src/server.ts` (atualiza)

**Steps:**
- [ ] `@fastify/static` serve `public/`
- [ ] Helmet CSP restritivo (ver Security Baseline seção 2)
- [ ] Teste manual: tenta carregar script externo não-whitelisted → bloqueado pelo browser
- [ ] Commit: `feat(server): static serving with strict CSP`

### Task 0.11 — Testes de segurança básicos

**Arquivos:**
- `tests/auth.test.ts`, `tests/security.test.ts`

**Steps:**
- [ ] Setup: Testcontainers Postgres → `prisma migrate deploy` em cada run
- [ ] `auth.test.ts`:
  - signup cria user; email duplicado retorna mesma msg (anti-enum)
  - login com credenciais erradas: 5 tentativas → 6ª bloqueada por rate limit
  - login sem email verificado: rejeitado
  - logout deleta session
  - reset password revoga todas sessions
- [ ] `security.test.ts`:
  - CSRF: POST sem header `X-CSRF-Token` → 403
  - IDOR: user A tenta acessar session de user B → 404
  - Mass assignment: PATCH enviando `emailVerified: true` é ignorado
  - Rate limit: 6ª tentativa login em 15min → 429
- [ ] Commit: `test: auth and security baseline tests`

### Task 0.12 — Deploy Coolify

**Arquivos:**
- `Dockerfile` (produção), `docker-compose.yml` (dev), `README.md` (deploy steps)

**Steps:**
- [ ] No Coolify: criar nova Application, apontar pro repo branch `main`
- [ ] Adicionar resource Postgres 16 no mesmo projeto
- [ ] Configurar env vars: `DATABASE_URL`, `SESSION_SECRET` (`openssl rand -hex 64`), `RESEND_API_KEY`, `APP_URL=https://businesscalc.dominio.com`, `NODE_ENV=production`
- [ ] Configurar domínio + TLS (Let's Encrypt)
- [ ] Dockerfile exposes port `3000` (Fastify default) — atualizar Coolify
- [ ] Health check: `GET /api/health` retornando `{ status: "ok", version: "..." }`
- [ ] Post-deploy hook: `npx prisma migrate deploy` roda no container antes do start
- [ ] Teste end-to-end: signup real em prod, verifica email, login, logout
- [ ] Commit: `chore(deploy): coolify config + prisma migrate on boot`

### Critérios de conclusão Fase 0

- [ ] `npm test` passa (auth + security)
- [ ] App deployado no Coolify acessível via HTTPS
- [ ] Usuário consegue: signup → receber email → verify → login → ver app → logout → reset password
- [ ] Todas as rotas POST/PUT/PATCH/DELETE têm CSRF
- [ ] CSP headers ativos (testar em `securityheaders.com`)
- [ ] Rate limits ativos (teste manual)
- [ ] Audit logs populando para eventos de auth

---

## Fase 1 — Persistência + Entrada Manual (MVP)

**Objetivo**: Dados vão pro BD (não mais localStorage). Usuário consegue criar períodos, preencher DRE/FC campo-a-campo via forms nativos, importar de XLSX, ver dashboard, salvar metas. **Este é o escopo do MVP que vai pra produção.**

**Duração estimada**: 2 sprints (~2 semanas de trabalho focado)

**Branch**: `claude/saas-fase1-persistencia`

### Task 1.1 — Schemas e rotas de Periods

**Arquivos:**
- `src/schemas/period.schema.ts`
- `src/routes/periods.ts`
- `src/services/period.service.ts`

**Steps:**
- [ ] `CreatePeriodSchema`: name (max 80), year (1990-2100), type (enum DRE|FC)
- [ ] `UpdatePeriodSchema`: name, status (enum)
- [ ] `period.service.ts`:
  - `list(userId, type?)` → só do user
  - `create(userId, data)` → cria Period
  - `get(userId, id)` → **verifica ownership**, 404 se não achado ou não dono
  - `update(userId, id, data)` → whitelist de campos
  - `delete(userId, id)` → cascata remove entries + metas
- [ ] Rotas (todas `requireAuth`):
  - `GET /api/periods?type=DRE|FC`
  - `POST /api/periods`
  - `GET /api/periods/:id`
  - `PUT /api/periods/:id`
  - `DELETE /api/periods/:id`
- [ ] Audit logs: `period.create`, `period.update`, `period.delete`
- [ ] Testes: IDOR (user A não acessa period de user B), mass assignment
- [ ] Commit: `feat(periods): CRUD with ownership checks and audit`

### Task 1.2 — Schemas e rotas de Entries

**Arquivos:**
- `src/schemas/entry.schema.ts`
- `src/routes/entries.ts`
- `src/services/entry.service.ts`

**Steps:**
- [ ] `UpsertEntriesSchema`: array de `{ category: string (enum das 20 categorias), monthly: number[12] }`
- [ ] Cada valor monthly: number entre -10^12 e 10^12, max 2 decimais
- [ ] `entry.service.ts`:
  - `getByPeriod(userId, periodId)` → verifica ownership do period → retorna entries
  - `upsertMany(userId, periodId, entries)` → transaction: delete entries ausentes + upsert presentes
- [ ] Rotas:
  - `GET /api/periods/:id/entries` → { entries, computed: {...} }
  - `PUT /api/periods/:id/entries` → body `{ entries: [...] }`
- [ ] Cálculos derivados (receitaLiq, lucroBruto, etc) **sempre server-side** — never trust client
- [ ] Audit log: `entries.update` com metadata `{ periodId, categoriesChanged: [...] }`
- [ ] Commit: `feat(entries): upsert with server-side calculations`

### Task 1.3 — Schemas e rota de Metas

**Arquivos:**
- `src/schemas/meta.schema.ts`
- `src/routes/metas.ts` (ou inline em periods)

**Steps:**
- [ ] `UpsertMetaSchema`: todos campos opcionais, todos decimal(14,2) ou int
- [ ] Rota `PUT /api/periods/:id/meta` → upsert Meta
- [ ] Rota `GET /api/periods/:id/meta` → retorna meta ou null
- [ ] Commit: `feat(metas): upsert endpoint`

### Task 1.4 — Upload XLSX server-side

**Arquivos:**
- `src/services/xlsx.service.ts`
- `src/routes/uploads.ts`

**Steps:**
- [ ] Mover parser do frontend pro backend (SheetJS no Node funciona idêntico)
- [ ] `xlsx.service.ts`:
  - `parseBuffer(buffer)`: valida magic bytes (`50 4B 03 04`), rejeita se não ZIP
  - `XLSX.read(buf, { dense: true, cellFormula: false, cellHTML: false, bookVBA: false })` — mitigação XXE/macro
  - Extrai DRE, FC, Metas sheets por label anchoring (mesma lógica já implementada)
  - Retorna `{ dre: {...}, fc: {...}, metas: {...} }`
- [ ] `generateTemplate()`: move lógica do frontend, retorna Buffer
- [ ] Rotas:
  - `GET /api/template.xlsx` → retorna template
  - `POST /api/periods/:id/upload` (multipart, max 10 MB) → parse → upsert entries + meta do period
- [ ] Validação extra: MIME, extensão, magic bytes triplo
- [ ] Não salva arquivo em disco; processa em memória e descarta
- [ ] Audit: `period.upload` com `{ filename (sanitizado), size, categoriesImported }`
- [ ] Commit: `feat(xlsx): server-side parsing with security hardening`

### Task 1.5 — Forms de entrada manual no frontend

**Arquivo:**
- `public/app.html` (extensão das tabs DRE/FC existentes)
- Novo CSS + JS na mesma linha do existente

**UI proposta:**

Na tab DRE/FC, além do botão "Baixar Template" e upload, adicionar:
- Lista de períodos do usuário (`GET /api/periods`)
- Botão `+ Novo Período` abre modal com `name`, `year`, `type`
- Ao selecionar período → carrega entries via API
- **Três modos de edição**:
  1. **Tabela editável inline** (recomendado): mesma tabela DRE/FC atual, mas com `contenteditable` ou `<input>` em cada célula. Editar célula → debounce 500ms → autosave via PUT
  2. **Upload XLSX**: cola os valores do XLSX no período selecionado
  3. **Bulk paste**: colar do Excel (Ctrl+V) → parseia tab-separated values

**Steps:**
- [ ] Componente "Period picker": dropdown + botão novo/deletar
- [ ] Estado client: `currentPeriod`, `entries`, `dirty` flag
- [ ] Tabela editável: cada célula monetária vira `<input type="text" class="money-input">` com a máscara BRL já existente
- [ ] Autosave com debounce: acumula mudanças e envia PUT com todos entries do período (simpler que delta)
- [ ] Indicador visual de save: "Salvando..." → "Salvo há 3s" → "Erro, tentar novamente"
- [ ] Recomputa dashboard (charts + KPIs + insights) quando entries mudam
- [ ] Form de Metas inline na mesma tab (seção expansível)
- [ ] Botão "Finalizar período" muda status DRAFT → FINALIZED (freeze: só admin reabre)
- [ ] Commit: `feat(ui): editable DRE/FC tables with autosave + period picker`

### Task 1.6 — Migração de dados localStorage → DB (primeiro login)

**Objetivo**: Usuários que já tinham dados no localStorage (antes do SaaS) podem migrar.

**Steps:**
- [ ] No `app.html`, após login, checar `localStorage.getItem('bc-dre')` / `bc-fc`
- [ ] Se existir e user não tem periods ainda → banner: "Detectamos dados salvos no seu navegador. Importar como período 'Migração'?"
- [ ] Se sim: POST `/api/periods` + PUT entries/meta → remove do localStorage
- [ ] Commit: `feat(migration): localStorage -> DB one-time import on first login`

### Task 1.7 — Remover localStorage persistence (fallback)

**Steps:**
- [ ] Remover `localStorage.setItem('bc-dre' / 'bc-fc')` (dados agora só no BD)
- [ ] Manter leitura para flow de migração (task 1.6), depois apagar
- [ ] Commit: `refactor: remove localStorage as primary persistence`

### Task 1.8 — Testes E2E dos fluxos

**Arquivos:**
- `tests/periods.test.ts`, `tests/xlsx.test.ts`, `tests/e2e.test.ts`

**Steps:**
- [ ] `periods.test.ts`: CRUD completo, ownership, mass assignment
- [ ] `xlsx.test.ts`: parse XLSX válido, rejeita MIME errado, rejeita magic bytes errados, rejeita >10MB, rejeita com VBA
- [ ] `e2e.test.ts` (supertest):
  - signup → verify → login → create period → PUT entries → GET entries → verify computed values
- [ ] Commit: `test: E2E flows for periods and xlsx`

### Critérios de conclusão Fase 1

- [ ] Usuário consegue criar, listar, editar, deletar períodos
- [ ] Tabela DRE/FC editável com autosave funcionando
- [ ] Upload XLSX popula período existente
- [ ] Template download funciona
- [ ] Metas salvas no BD
- [ ] Cálculos derivados consistentes server-side
- [ ] Dados nunca mais vão pro localStorage (exceto migração)
- [ ] IDOR blindado: user A nunca vê dados de user B
- [ ] Audit logs completos pros novos eventos
- [ ] Deploy em produção sem downtime (migration compatível)

---

## Fase 2 — Histórico & Comparação (Post-MVP)

**Objetivo**: Usuário consegue ver múltiplos períodos lado a lado, comparar YoY/MoM, ver evolução de metas ao longo do tempo, exportar consolidado.

**Duração estimada**: 1 sprint

### Task 2.1 — Lista de períodos e "arquivo"

- [ ] View "Meus Períodos" com cards: nome, ano, tipo, status, total de entries, lucro líquido (DRE) ou saldo (FC)
- [ ] Filtros: por ano, por tipo, por status
- [ ] Busca por nome

### Task 2.2 — Comparação entre períodos

- [ ] Seletor multi (até 4 períodos)
- [ ] Tabela comparativa: linhas = categorias, colunas = períodos + Δ% absoluto + Δ% relativo
- [ ] Gráfico de linhas sobreposto (Receita do período A vs B vs C)
- [ ] Insights comparativos gerados: "Receita cresceu 23% YoY", "Pessoal +40% sem crescer receita proporcional", etc
- [ ] Endpoint: `GET /api/periods/compare?ids=uuid1,uuid2,...`

### Task 2.3 — Evolução de Metas

- [ ] View "Metas & Performance" mostrando evolução de batimento de metas período a período
- [ ] Gráfico de barras empilhadas (meta vs realizado) por ano
- [ ] Indicador: "Você bateu meta de receita em 3 dos últimos 5 anos"

### Task 2.4 — Export consolidado

- [ ] `GET /api/periods/export?ids=...` retorna XLSX com abas separadas por período + aba de comparação
- [ ] Opção PDF (gerado server-side com puppeteer headless ou fim-fim com biblioteca like pdfkit)

**Critérios:**
- [ ] Comparar 4 períodos simultâneos renderiza em < 500ms
- [ ] Export XLSX funciona com até 10 períodos

---

## Fase 3 — Segurança Avançada + LGPD

**Objetivo**: Elevar o patamar de segurança pra produção séria com dados financeiros.

**Duração estimada**: 1 sprint

### Task 3.1 — 2FA (TOTP)

- [ ] Setup TOTP: user escaneia QR code (otplib), salva `totpSecret` (encrypted AES-256-GCM)
- [ ] Backup codes (10 códigos single-use, hash argon2)
- [ ] Login flow: após senha, pede código TOTP se enabled
- [ ] Recovery via backup code ou email de emergência (DPO aprova)
- [ ] Endpoint `POST /api/auth/2fa/enable`, `verify`, `disable`

### Task 3.2 — Criptografia em repouso (coluna-level)

- [ ] Helper `src/utils/crypto.ts` já stubado: implementar AES-256-GCM com `ENCRYPTION_KEY`
- [ ] Aplicar em: `totpSecret`, `backupCodes`, `audit_logs.metadata` se contiver PII
- [ ] Migração: migrate existente pra criptografado (batch script)
- [ ] Key rotation procedure documentada

### Task 3.3 — Backup automatizado

- [ ] Script `scripts/backup.sh`: `pg_dump` → criptografa com age → upload S3/R2
- [ ] Cron diário 3 AM BRT via Coolify
- [ ] Retenção: 30 dias diário, 12 meses mensal
- [ ] **Teste de restore trimestral** (procedimento documentado)

### Task 3.4 — LGPD compliance endpoints

- [ ] `GET /api/me/export` — retorna JSON completo com tudo do user (zip: user.json, periods.json, entries.json, audit.json)
- [ ] `DELETE /api/me` — soft delete inicial: `deletedAt` + revoga sessions + envia email confirmação; 30 dias depois, hard delete
- [ ] Audit logs preservados por 6 meses com `userId` NULL (anonimizado)
- [ ] Política de Privacidade + Termos de Uso HTML públicos (`/privacy.html`, `/terms.html`)
- [ ] Banner de consentimento de cookies (técnicos only — sem tracking = banner simples)

### Task 3.5 — Pen-test checklist

Rodar manualmente antes de ir pra produção:

- [ ] IDOR em todas as rotas com `:id` (trocar UUID por UUID de outro user)
- [ ] CSRF: request sem header X-CSRF-Token → 403
- [ ] XSS: input `<script>` em `name`, `period.name` → não renderiza como HTML
- [ ] SQL injection: `'; DROP TABLE users; --` no email/name → Prisma safe
- [ ] Open redirect: `?next=//evil.com` não redireciona
- [ ] Path traversal: filename `../../../etc/passwd` no upload → rejeitado
- [ ] Rate limit efetivo em signup/login/forgot
- [ ] Timing attack: login com email inexistente vs existente tem mesmo tempo (argon2 idempotente)
- [ ] Header scan: `securityheaders.com` e `observatory.mozilla.org` → nota A+

### Task 3.6 — WAF / DDoS protection

- [ ] Coolify + Cloudflare (front) — configurar DNS pra usar Cloudflare proxy
- [ ] Regras WAF: bloquear padrões comuns (SQLi, XSS signatures)
- [ ] Bot fight mode pra páginas públicas

**Critérios:**
- [ ] 2FA funcional e recuperável
- [ ] Todas colunas sensíveis criptografadas
- [ ] Backup testado + restore testado
- [ ] LGPD endpoints funcionais
- [ ] Pen-test checklist 100% green
- [ ] securityheaders.com nota A+

---

## Fase 4 — SaaS Features (Escala)

**Objetivo**: Transformar em SaaS vendável: planos, times, billing.

**Duração estimada**: 2-3 sprints

### Task 4.1 — Organizations (multi-tenant real)

- [ ] Modelo `Organization` com `owner` + `members` (roles: OWNER, ADMIN, EDITOR, VIEWER)
- [ ] Migration: users existentes ganham Organization pessoal automaticamente
- [ ] Periods agora pertencem a Organization, não User direto
- [ ] `OrgMember` com role; checks de RBAC

### Task 4.2 — Billing (Stripe)

- [ ] Stripe Customer por Organization
- [ ] Plans: Free (1 org, 2 periods), Pro ($19/mo, orgs, 50 periods), Business ($49/mo, unlimited, roles)
- [ ] Webhook endpoint pra eventos Stripe (com signature verification)
- [ ] Feature gating no backend (middleware `requirePlan('pro')`)
- [ ] Trial 14 dias Pro ao signup

### Task 4.3 — Admin panel

- [ ] `/admin` — só users com `isAdmin` flag (manual no BD inicialmente)
- [ ] Lista users, orgs, periods, audit logs filtrável
- [ ] Ação: reset user password, revogar sessions, banir conta
- [ ] Separado do app principal (`src/routes/admin/*`)

### Task 4.4 — Analytics produto

- [ ] Eventos internos (sem trackers third-party): `user.signup`, `period.created`, etc → tabela `events`
- [ ] Dashboard interno de métricas: DAU/MAU, retention cohort, churn
- [ ] Plausible ou Umami self-hosted pra page views anon

### Task 4.5 — API pública + docs

- [ ] Endpoints `/api/v1/*` com API keys (per-org)
- [ ] Rate limits por key
- [ ] OpenAPI 3.1 spec auto-gerada (fastify-swagger)
- [ ] Docs HTML em `/docs`

**Critérios:**
- [ ] Signup → trial → upgrade Pro via Stripe funciona
- [ ] Time de 3 pessoas compartilha períodos com roles diferentes
- [ ] Admin panel operacional
- [ ] API pública documentada

---

## Deploy & Operações

### Ambiente de produção (Coolify)

1. **VPS mínima recomendada**: 2 vCPU / 4 GB RAM / 40 GB SSD (~R$60/mês em provedor BR)
2. **Services no Coolify**:
   - `app` (Docker build do Dockerfile) — porta 3000 interna
   - `postgres:16-alpine` — volume persistente 10 GB
   - `backups` (cron container) — volume pra dumps
3. **Domínio**: `businesscalc.dominio.com.br` (TLS Let's Encrypt automatizado via Traefik)
4. **Email subdomain**: `mail.dominio.com.br` com SPF/DKIM/DMARC configurados pra Resend

### Env vars (produção)

```
NODE_ENV=production
APP_URL=https://businesscalc.dominio.com.br
DATABASE_URL=postgresql://user:pass@postgres:5432/businesscalc?schema=public
SESSION_SECRET=<openssl rand -hex 64>
ENCRYPTION_KEY=<openssl rand -hex 32>
RESEND_API_KEY=re_...
SENTRY_DSN=https://...  # Fase 3
```

### CI/CD (Fase 0 → sempre)

- Push em `main` → Coolify webhook → build + deploy
- Pre-deploy: `prisma migrate deploy` (não `migrate dev`)
- Health check `/api/health` antes de marcar deploy como ok
- Rollback: Coolify mantém imagem anterior, revert em 1 clique

### Monitoramento

- Logs: pino JSON → Coolify log viewer (Fase 0)
- APM: Sentry (Fase 3) — captura erros não tratados + traces lentos
- Uptime: UptimeRobot free (ping `/api/health` a cada 5min)
- Alertas: Sentry → email + Telegram bot

---

## Testing Strategy

### Pirâmide

1. **Unit tests** (Vitest) — helpers (password, tokens, crypto, xlsx parser)
2. **Integration tests** (Vitest + Testcontainers) — services + DB real descartável
3. **API tests** (Supertest) — rotas end-to-end sem UI
4. **E2E tests** (Playwright, Fase 2+) — fluxos críticos no browser
5. **Security tests** — checklist manual + `security.test.ts` automatizado

### Coverage target

- Fase 0: ≥80% em auth + middleware
- Fase 1: ≥70% geral
- Fase 3: ≥85% em security-critical (auth, crypto, access control)

### CI (GitHub Actions, Fase 0.11+)

```yaml
# .github/workflows/test.yml
- npm ci
- npx prisma generate
- npm test  # vitest + testcontainers
- npm run lint
- npm audit --audit-level=high  # fail on high vulns
```

---

## Roadmap visual

```
Hoje        Fase 0        Fase 1        Fase 2        Fase 3        Fase 4
SPA  ────▶  Auth   ────▶  Manual  ────▶ Histórico ──▶ Segurança ─▶ SaaS
            + BD           entry         + compare    + LGPD       + billing
            1 sprint       2 sprints     1 sprint     1 sprint     2-3 sprints
            MVP:           ◀━━━━━━━━ PRODUÇÃO ━━━━━━━▶
```

**Total MVP (Fase 0 + 1): ~3 sprints** (≈ 3 semanas de trabalho focado)

---

## Riscos conhecidos e mitigação

| Risco                                               | Probabilidade | Impacto | Mitigação                                                    |
|-----------------------------------------------------|---------------|---------|--------------------------------------------------------------|
| Vazamento de dados financeiros                      | Baixa         | Crítico | Security Baseline + pen-test + criptografia em repouso       |
| Downtime por deploy                                 | Média         | Médio   | Health check + rollback automatizado                         |
| Perda de dados por falha de BD                      | Baixa         | Crítico | Backup diário + teste trimestral de restore                  |
| Custo infra cresce sem receita                      | Alta          | Médio   | VPS R$60/mês suporta milhares de users; trigger upgrade 10k+ |
| Usuário perde senha sem 2FA ainda                   | Média         | Baixo   | Reset via email funciona desde Fase 0                        |
| SheetJS XXE                                         | Baixa         | Alto    | Config sem formula/VBA/HTML; magic bytes + MIME validation   |
| Abuse/spam no signup                                | Alta          | Médio   | Rate limit 3 contas/hora/IP; verify email obrigatório        |

---

## Próximos passos

1. **Aprovar este plano** (você) ou pedir ajustes
2. **Criar branch `claude/saas-fase0-fundacao`** (eu)
3. **Começar Task 0.1 — scaffolding** (eu)
4. **Commit frequente, push, checkpoint ao fim de cada task** (processo)
5. **Revisão ao fim da Fase 0** antes de ir pra Fase 1



