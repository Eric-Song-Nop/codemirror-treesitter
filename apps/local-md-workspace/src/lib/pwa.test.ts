import { describe, expect, it, vi } from "vite-plus/test";
import {
  appServiceWorkerPath,
  appServiceWorkerScope,
  registerAppServiceWorker,
  shouldRegisterAppServiceWorker,
  type AppServiceWorkerEnvironment,
} from "./pwa.ts";

describe("PWA service worker registration", () => {
  it("only registers for production builds with service worker support", () => {
    expect(
      shouldRegisterAppServiceWorker(
        environment({
          isProduction: false,
          serviceWorker: { register: vi.fn() },
        }),
      ),
    ).toBe(false);
    expect(
      shouldRegisterAppServiceWorker(
        environment({
          isProduction: true,
          protocol: "http:",
          serviceWorker: { register: vi.fn() },
        }),
      ),
    ).toBe(false);
    expect(
      shouldRegisterAppServiceWorker(
        environment({
          isProduction: true,
          serviceWorker: undefined,
        }),
      ),
    ).toBe(false);
    expect(
      shouldRegisterAppServiceWorker(
        environment({
          hostname: "app.grovemd.net",
          isProduction: true,
          protocol: "https:",
          serviceWorker: { register: vi.fn() },
        }),
      ),
    ).toBe(true);
  });

  it("allows production preview on localhost", () => {
    expect(
      shouldRegisterAppServiceWorker(
        environment({
          hostname: "localhost",
          isProduction: true,
          protocol: "http:",
          serviceWorker: { register: vi.fn() },
        }),
      ),
    ).toBe(true);
  });

  it("registers the root-scoped app service worker", async () => {
    let registration = {} as ServiceWorkerRegistration;
    let register = vi.fn(async () => registration);

    await expect(
      registerAppServiceWorker({
        isProduction: true,
        location: { hostname: "app.grovemd.net", protocol: "https:" },
        navigator: { serviceWorker: { register } },
      }),
    ).resolves.toBe(registration);

    expect(register).toHaveBeenCalledWith(appServiceWorkerPath, { scope: appServiceWorkerScope });
  });

  it("reports registration failures without breaking app startup", async () => {
    let error = new Error("registration denied");
    let onError = vi.fn();
    let register = vi.fn(async () => {
      throw error;
    });

    await expect(
      registerAppServiceWorker({
        isProduction: true,
        location: { hostname: "app.grovemd.net", protocol: "https:" },
        navigator: { serviceWorker: { register } },
        onError,
      }),
    ).resolves.toBeNull();

    expect(onError).toHaveBeenCalledWith(error);
  });
});

function environment({
  hostname = "app.grovemd.net",
  isProduction = true,
  protocol = "https:",
  serviceWorker,
}: {
  hostname?: string;
  isProduction?: boolean;
  protocol?: string;
  serviceWorker?: AppServiceWorkerEnvironment["navigator"]["serviceWorker"];
}): AppServiceWorkerEnvironment {
  return {
    isProduction,
    location: { hostname, protocol },
    navigator: { serviceWorker },
  };
}
