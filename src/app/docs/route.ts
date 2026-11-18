/**
 * GET /docs — referencia interactiva de la API (Scalar) sobre /api/v1/openapi.json.
 * HTML estático generado una sola vez a nivel de módulo (server-hoist-static-io).
 */

const SCALAR_VERSION = "1.76.4";

const HTML = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Techo Solar API · Documentación</title>
  <style>body{margin:0;background:#0c0a09}noscript{color:#f5f5f4;font-family:system-ui;padding:24px;display:block}</style>
</head>
<body>
  <noscript>Activa JavaScript o descarga la especificación en <a href="/api/v1/openapi.json">/api/v1/openapi.json</a>.</noscript>
  <div id="app"></div>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}"></script>
  <script>
    Scalar.createApiReference('#app', {
      url: '/api/v1/openapi.json',
      theme: 'saturn',
      darkMode: true,
      hideClientButton: false,
      metaData: { title: 'Techo Solar API' },
    })
  </script>
</body>
</html>`;

export function GET(): Response {
  return new Response(HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
