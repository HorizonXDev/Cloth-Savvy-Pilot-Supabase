// functions/occasions — GET /v1/occasions
//
// The occasion list is exactly the tenant's `tenants.settings.combos` keys
// (validated by settings.ts; documented defaults apply when absent). The
// server OWNS this list — there is no hardcoded occasion vocabulary anywhere
// in this API (the consumer's three hardcoded lists were not inherited).
//
// Resp: {request_id, occasions:[{occasion, sections:[...]}]} (sorted).

import { handle } from "../_pilot/http.ts";
import { readEnv } from "../_pilot/env.ts";
import { listOccasions } from "../_pilot/recipes.ts";

Deno.serve((req) =>
  handle(req, readEnv(), { endpoint: "occasions", auth: true, methods: ["GET"] }, async (ctx) => {
    const auth = ctx.auth!;
    return {
      body: {
        request_id: ctx.requestId,
        occasions: listOccasions(auth.settings),
      },
    };
  }),
);
