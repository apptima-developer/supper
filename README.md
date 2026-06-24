# SupportDesk MD Control

Internal support operations system built with Next.js App Router, TypeScript, Tailwind CSS, local Prompt font assets, and server-side JSON storage.

## Start

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

Initial local accounts:

| Role | Username | Password |
| --- | --- | --- |
| Admin | `admin` | `admin123` |
| Lead | `lead` | `lead123` |
| Support | `support` | `support123` |
| Sales | `sales` | `sales123` |

Replace the seeded passwords and set a strong `SESSION_SECRET` before production use.

## Data model

Operational files live under `data/`. Every repository write is Zod-validated, backs up the current JSON, writes a temporary file, and atomically renames it. Customer and ticket mutations emit audit entries; ticket updates also record field-level history.

Excel imports use a preview/commit workflow. SupportDesk workbooks read `Customer_MD_Control`, `Issues_Log`, and `Master`; Snow imports use `data/imports/mappings.json`. Imports upsert and never delete missing rows.

Monthly reports generate a branded seven-slide PPTX under `data/reports/generated/` and keep report job history in JSON.

## Verification

```bash
npm test
npm run lint
npm run build
```
