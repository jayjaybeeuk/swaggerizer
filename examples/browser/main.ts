/* Browser demo: orval client + Swaggerizer MSW mocks + the in-page debug menu. */
import { setupWorker } from "msw/browser";
import { mountDebugMenu } from "../../src/debug-menu";
import { createMocks, petstore, users } from "../../example_generated";

const server = new URLSearchParams(location.search).get("server") || undefined;
const mocks = createMocks({ server });

const calls: Record<string, () => Promise<unknown>> = {
  listPets: () => petstore.listPets(),
  showPetById: () => petstore.showPetById(1),
  createPet: () => petstore.createPet({ name: "Nibbles", species: "hamster" }),
  login: () => users.login({ username: "demo", password: "secret" }),
  getCurrentUser: () => users.getCurrentUser()
};

const out = document.getElementById("out")!;

async function main() {
  mountDebugMenu(mocks, { open: true });
  try {
    await setupWorker(...mocks.handlers).start({ onUnhandledRequest: "bypass", quiet: true });
  } catch (err) {
    out.textContent = `MSW could not start its service worker in this browser:\n${err}\n\nOpen the page in Chrome, Edge, Firefox or Safari.`;
  }
  document.querySelectorAll<HTMLButtonElement>("[data-call]").forEach(button => {
    button.addEventListener("click", async () => {
      const name = button.dataset.call!;
      out.textContent = `${name}() …`;
      try {
        const result: any = await calls[name]();
        out.textContent = `${name}() → ${result.status}\n\n${JSON.stringify(result.data, null, 2)}`;
      } catch (err) {
        out.textContent = `${name}() failed: ${err}`;
      }
    });
  });
}

main();
