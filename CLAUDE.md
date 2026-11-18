@AGENTS.md

# Techo Solar API

- Antes de escribir o revisar código React/Next.js, aplica el skill `vercel-react-best-practices` (`.claude/skills/vercel-react-best-practices`).
- Todos los endpoints usan `apiRoute()` de `src/lib/api/handler.ts`: auth, rate limit, errores RFC 9457 y log con `after()`.
- Los schemas de `src/lib/schemas.ts` validan la entrada y generan el OpenAPI: si cambias un endpoint, actualiza su schema y el ejemplo en `src/lib/openapi.ts`.
- Textos para el usuario final en español; nombres de campos JSON en inglés camelCase.
- Verifica con `npm test`, `npm run typecheck`, `npm run lint` y `npm run build`.
