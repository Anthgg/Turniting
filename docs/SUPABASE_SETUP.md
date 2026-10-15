# Supabase PostgreSQL

Supabase se usa como PostgreSQL gestionado. La aplicación web no utiliza el Data API ni claves Supabase; solo NestJS mantiene una conexión PostgreSQL a través de Prisma.

## Conexiones

1. Selecciona o crea un proyecto Turniting en la organización elegida.
2. En **Connect**, identifica los endpoints reales del proyecto y el modo adecuado para el entorno de ejecución. Guarda los valores de forma segura; no copies contraseñas ni URLs completas a este documento.
3. Configura `DATABASE_URL` para la conexión de aplicación y `DIRECT_URL` para tareas Prisma que requieran una conexión directa, si el modo de conexión seleccionado lo necesita.
4. Usa SSL y verifica que el método elegido sea compatible con la conectividad IPv4/IPv6 del despliegue.

La conexión directa de Supabase encaja con backends persistentes; el pooler puede ser necesario cuando la red no tiene IPv6 o el patrón de conexiones escala horizontalmente. El pooler de transacciones tiene restricciones de sesión y requiere desactivar prepared statements con Prisma. El nombre del host, el usuario y los parámetros se obtienen del panel **Connect** del proyecto real; no se inventan ni se derivan de un project ref.

## Prisma y migraciones

La versión del esquema Prisma de F000 usa `DATABASE_URL` para la aplicación y `DIRECT_URL` para migraciones. En Supabase:

```powershell
$env:DATABASE_URL = '<URL real de conexión de aplicación>'
$env:DIRECT_URL = '<URL real de migración/conexión directa>'
Set-Location backend
npx prisma generate
npx prisma migrate deploy
npx prisma migrate status
```

Usa una conexión directa para aplicar migraciones cuando el endpoint de aplicación vaya por un pooler. No ejecutes `migrate reset` contra un entorno compartido o de producción. Verifica la conectividad con `GET /api/health/db` y una operación Prisma de lectura/escritura controlada antes de exponer el frontend.

## Seguridad

- Guarda `DATABASE_URL` y `DIRECT_URL` en el gestor de secretos del entorno, nunca en el bundle frontend, el repositorio, una imagen ni logs.
- Usa un rol PostgreSQL dedicado con los permisos que requiera Prisma y la aplicación.
- No publiques `service_role` ni claves publishable en React; esta arquitectura no necesita ninguna de ellas.
- Supabase Data API puede permanecer sin uso; cualquier cambio a la configuración del proyecto debe validarse en el panel antes de aplicarse.

## Estado de este entorno

El F000 real debe registrar aquí el nombre/ref del proyecto, el modo de conexión escogido, el resultado de las migraciones y el smoke test, sin registrar secretos. Esos datos se completan únicamente después de verificar un proyecto accesible y sus credenciales reales.

## Referencias

- [Supabase: conectar a PostgreSQL](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase: guía de Prisma](https://supabase.com/docs/guides/database/prisma)
- [Supabase: pooling y límites](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits)
- [Prisma ORM v6: `directUrl`](https://www.prisma.io/docs/v6/orm/prisma-schema/overview/data-sources)
