// functions/tenant_account — portal "who am I" + settings view.
//
//   GET  -> { user:{id,email}, tenant:{id,slug,name,status},
//             settings:{...validated}, embedding_model }
//
// The ONLY thing this route tells you is what the session already owns:
// its user, its ONE tenant, that tenant's settings. Nothing here is
// secret from the tenant (their own settings), and nothing here is
// reachable without a valid portal session (resolvePortalSession).
//
// Password changes are NOT handled here: the portal calls GoTrue
// (supabase.auth.updateUser) directly with the browser's session — the
// service-role client inside a function has no user session to modify.
//
// Auth: portal session (Supabase Auth user JWT → tenant_users row).
// NOT metered — portal traffic never touches usage_events.

import { readEnv } from "../_pilot/env.ts";
import { handle } from "../_pilot/http.ts";
import { resolvePortalSession, tenantOrigins } from "../_tenant/tenant.ts";

Deno.serve((req) =>
  handle(
    req,
    readEnv(),
    { endpoint: "tenant.account", auth: false, methods: ["GET"], corsOrigins: tenantOrigins(readEnv()) },
    async (ctx) => {
      const session = await resolvePortalSession(ctx.req, ctx.db, ctx.requestId);
      return {
        body: {
          request_id: ctx.requestId,
          user: { id: session.userId, email: session.email },
          tenant: {
            id: session.tenantId,
            slug: session.tenantSlug,
            name: session.tenantName,
            status: "active", // resolvePortalSession 403s anything else
          },
          embedding_model: session.tenantModel,
          settings: session.settings,
        },
      };
    },
  ),
);
