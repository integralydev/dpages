# Coste de Cloud Run de dpages-backend: CPU siempre asignada y minScale

Análisis del 12/11/2026. **Aplicado el 13/11/2026:** CPU solo durante las
peticiones, manteniendo `minScale=1` (ver [Cambio aplicado](#cambio-aplicado-13112026)).

Quitar solo el `minScale=1` no ahorra casi nada. Lo que baja el coste es dejar
de asignar la CPU siempre. Con la CPU solo durante las peticiones y manteniendo
`minScale=1`, Cloud Run pasaría de unos 48 $/mes a unos 8–12 $/mes, y hoy el
backend lo aguanta sin romper nada.

**El periodo:** el informe de Billing → Reports (proyecto `dpages`, agrupado
por servicio) daba 48,33 $ para Cloud Run. Se asume que el periodo era un mes.
Cuadra: 1 vCPU y 512 MiB encendidos todo el mes, a la tarifa de europe-west1 y
descontando la capa gratuita, salen unos 45–50 $. Si el periodo era otro, las
cifras cambian en proporción.

## Cuánto bajaría (precios de lista aproximados, por mes)

| Configuración                                   | Cloud Run/mes | Ahorro       |
| ----------------------------------------------- | ------------- | ------------ |
| Actual: CPU siempre asignada + `minScale=1`     | ~48 $         | —            |
| Quitar solo `minScale=1` (CPU siempre asignada) | ~45–48 $      | ≈ 0          |
| **CPU solo en peticiones + `minScale=1`**       | **~8–12 $**   | **~35–40 $** |
| CPU solo en peticiones + `minScale=0`           | ~0–2 $        | ~46 $        |

- **Quitar solo `minScale` no sirve de nada.** Con la CPU siempre asignada se
  paga la instancia mientras está viva, inactiva incluida, y Cloud Run tarda
  unos 15 minutos en apagar una instancia sin uso. Como sync-comandes entra
  cada 5 minutos, la instancia no se apaga nunca y se paga igual.
- **Con la CPU solo en peticiones y `minScale=1`,** la instancia en reposo se
  paga a la tarifa de inactividad, que es mucho más barata: unos 7 $ de CPU y
  3 $ de memoria. El tiempo activo (8.640 pasadas de sync de ~8 s más el uso
  de la app) cabe casi entero en la capa gratuita.
- **Con `minScale=0` además,** el reposo no cuesta nada. En la práctica casi no
  habría arranques en frío, porque el sync cada 5 minutos mantiene la
  instancia caliente. Pero no está garantizado, sobre todo después de un
  despliegue. Ahorra otros ~10 $.

## Si el backend lo aguanta

Con la CPU solo en peticiones, **sí, hoy no se rompe nada**:

- **Las tareas de Scheduler** (sync-comandes y las otras) son síncronas: todo
  el trabajo ocurre antes de responder, así que la CPU está asignada mientras
  trabajan.
- **No hay temporizadores ni procesos en segundo plano:** no hay `setInterval`
  ni `setTimeout` en el código del servidor. El pool de Postgres tiene
  manejador de `error`, así que si Cloud SQL corta una conexión inactiva
  mientras la CPU está congelada, el pool la descarta y abre otra.
- **El único código que trabaja después de responder es el webhook,** y no ha
  llegado ninguno en 60 días. **Si algún día se activa,** habría que volver a
  la CPU siempre asignada o procesarlo antes de responder. Si no, el `GET` y la
  transformación quedarían congelados hasta la siguiente petición. El sync
  recoge igualmente esos pedidos en 5 minutos, así que no se pierde nada, pero
  el evento quedaría mal registrado.
- **El sync y la IP fija no cambian:** la salida por la VPC y el NAT funciona
  igual con cualquiera de las dos opciones.

## Recomendación

CPU solo en peticiones y mantener `minScale=1`. Es el ~80 % del ahorro sin el
riesgo de arranques en frío para el equipo. El comando sería:

```bash
gcloud run services update dpages-backend --project dpages --region europe-west1 --cpu-throttling
```

## Cambio aplicado (13/11/2026)

- Se lanzó el comando de arriba. Revisión anterior: `dpages-backend-00084-dt6`
  (deploy de la release del 13/11, CPU siempre asignada). Revisión nueva:
  `dpages-backend-00085-lbm`, con `run.googleapis.com/cpu-throttling=true`,
  sirviendo el 100 % del tráfico.
- `minScale=1`, `maxScale=2`, 1 vCPU y 512 MiB, sin cambios.
- La red se conserva: `network-interfaces` = `dpages-vpc`/`dpages-egress` y
  `vpc-access-egress=all-traffic` (salida por la IP fija, que es la que tiene
  desbloqueada cdmon). Cloud SQL sigue conectado.
- Verificado: la pasada de `/tasques/sync-comandes` de las 14:15 UTC (Cloud
  Scheduler) respondió 200 en `dpages-backend-00085-lbm` y logueó
  "Ingesta completada" unos 3 s después.
- `deploy.yml` hace `gcloud run deploy` solo con `--image`, así que los
  próximos despliegues mantienen la CPU solo en peticiones.
- **Si se activa el webhook de WooCommerce**, hay que volver a la CPU siempre
  asignada (`--no-cpu-throttling`) o procesar el evento antes de responder.
  Anotado en el ADR del webhook (`docs/decisiones-arquitectura.md`).
- Para deshacerlo:
  `gcloud run services update dpages-backend --project dpages --region europe-west1 --no-cpu-throttling`.
- Ahorro esperado: de ~48 $/mes a ~8–12 $/mes. Comprobarlo en Billing →
  Reports dentro de unas semanas.

## Otras cosas de la factura

- **Cloud SQL (8,95 $)** es aparte y no cambia con nada de esto.
- **Networking (0,01 $)** aún no incluye el Cloud NAT ni la IP estática del
  12/11/2026. Hay que sumarle unos pocos dólares al mes a partir de ahora.
