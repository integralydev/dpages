# infra/gcp

Placeholder para scripts de aprovisionamiento de Cloud Run, Cloud SQL, Secret
Manager y Cloud Scheduler. Se completa cerca de la puesta en producción
(objetivo: finales de septiembre de 2026).

Región prevista: europe-west1 o europe-southwest1 (RGPD — los datos de
ciudadanos españoles no salen de la UE).

Recursos a aprovisionar:

- **Cloud Run** — backend (`packages/backend/Dockerfile`).
- **Cloud SQL para PostgreSQL** — mismo esquema que en local, aplicado vía
  `npm run migrate`.
- **Secret Manager** — credenciales de WooCommerce de sólo lectura, secreto
  del endpoint de tareas, credenciales de base de datos.
- **Cloud Scheduler** — dispara `POST /tasques/sync-comandes`,
  `/sync-cataleg` y `/reconciliar` (ver ADR-009 en
  `docs/decisiones-arquitectura.md`).
- **Firebase Auth** — autenticación de los cuatro paneles; sin datos de
  negocio.

## Monitorización (alertas)

Creada el 22/10/2026 tras una caída de la sincronización de unas 33 h que
nadie detectó (21/10 07:40 → 22/10 16:55, hora de Madrid:
`Connect Timeout Error (dpages.cat:443)` sólo desde Cloud Run, probable
bloqueo de IP en el cortafuegos del hosting de WordPress, cdmon).

- **Métrica de logs** `sync_comandes_fallades` (contador): intentos fallidos
  de la tarea de Cloud Scheduler `sync-comandes`
  (`AttemptFinished` con severidad `ERROR`). Cuenta tanto un 5xx del backend
  como un backend inaccesible.
- **Política de alerta** "dPagès — sincronització de comandes amb WooCommerce
  caiguda": salta con **3 o más fallos en 20 minutos** (unas 3 ejecuciones
  seguidas, la tarea corre cada 5 min); un fallo aislado (p. ej. durante un
  cambio de revisión) no avisa. Se cierra sola 30 min después de volver a
  funcionar.
- **Canal**: correo a francesc@integralyaisolutions.com.

Ver/editar en Cloud Console → Monitoring → Alerting (proyecto `dpages`).
Las tareas `sync-cataleg` y `reconciliar` están en pausa a fecha de hoy y no
tienen alerta.
