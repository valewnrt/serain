-- Serain: delivery as its own component in the health check (D44). Additive.
--
-- The dead man's switch via Healthchecks.io only checked whether the stream to Photon
-- is up. If it is up and every message still fails ("Target not allowed"
-- after a number change, Spectrum's delivery bug from August), nobody notices:
-- the only channel to the owner is exactly the one that is broken. `delivery` turns unhealthy
-- when send attempts fail repeatedly, and sends the dead man's switch to `/fail`.

alter table public.component_status drop constraint if exists component_status_component_check;
alter table public.component_status
  add constraint component_status_component_check
  check (component in ('process', 'channel', 'db', 'model', 'delivery'));
