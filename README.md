# brainy-web
Landing Brainy con Legal y Contacto

## Deploy

Este proyecto se publica como sitio estático. No necesita build ni bundler para funcionar.

Sube al hosting actual estos archivos y carpetas:

- `index.html`
- `contact.html`
- `privacy.html`
- `terms.html`
- `testers.html`
- `testers/`
- `assets/`
- `CNAME`

No hace falta subir:

- `node_modules/`
- `package-lock.json`
- `package.json`

La página de testers carga Firebase desde CDN y guarda en Firestore directamente desde el navegador.

## Testers

La página privada de testing vive en [testers.html](testers.html) y también tiene una ruta amigable en [testers/index.html](testers/index.html) para que el hosting pueda resolver `/testers` o `/testers/`.

### Firebase

1. Crea un proyecto en Firebase.
2. Activa Firestore Database.
3. Copia la configuración web del proyecto en [testers.html](testers.html) dentro del bloque `FIREBASE_CONFIG`.
4. Crea una colección llamada `brainytesters`.
5. Publica la carpeta del sitio en el mismo hosting estático que ya usas.

### Estructura de datos

Cada tester guarda un documento con el id del username: `francia`, `benja` o `naty`.

El documento guarda:

- `username`
- `updatedAt`
- `items`

### Reglas sugeridas

Si la página se usa sólo internamente, puedes empezar con reglas restrictivas por documento y luego ajustarlas según tu despliegue.
