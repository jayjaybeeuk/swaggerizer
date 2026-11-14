import { defineConfig } from "../../../src/config";
import { rewardsEmpty, rewardsPopulated } from "@example/fixtures/rewards";

export default defineConfig({
  delay: 0,
  specs: {
    bff: {
      file: "./example-bff.json",
      aliases: { "/banking/bff/v4/": "/v4/banking/" },
      output: "./out/client",
      mocksOutput: "./out/mock-service",
      scenarios: {
        getBusinessRewards: {
          populated: { status: 200, body: rewardsPopulated },
          empty: { status: 200, body: rewardsEmpty, summary: "Nothing earned yet" },
          accountLimitExceeded: { status: 422, body: { code: "ACCOUNT_LIMIT_EXCEEDED" } }
        },
        notAnOperation: { x: { status: 200 } }
      },
      handlers: {
        searchTransactions: ({ body, json }) =>
          (body as any)?.cursor ? json({ items: ["c", "d"], nextCursor: null }) : json({ items: ["a", "b"], nextCursor: "page-2" }),
        listExpenses: ({ params, store, json }) => json((store.get(`expenses:${params.businessId}`) as unknown[]) ?? []),
        createExpense: ({ params, body, store, json }) => {
          const key = `expenses:${params.businessId}`;
          const list = ((store.get(key) as unknown[]) ?? []).concat(body);
          store.set(key, list);
          return json(body, 201);
        }
      }
    }
  }
});
