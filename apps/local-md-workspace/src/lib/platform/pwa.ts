export const appServiceWorkerPath = "/service-worker.js";
export const appServiceWorkerScope = "/";

type ServiceWorkerRegistrar = {
  register(
    scriptURL: string | URL,
    options?: RegistrationOptions,
  ): Promise<ServiceWorkerRegistration>;
};

export type AppServiceWorkerNavigator = {
  serviceWorker?: ServiceWorkerRegistrar;
};

export type AppServiceWorkerLocation = Pick<Location, "hostname" | "protocol">;

export type AppServiceWorkerEnvironment = {
  isProduction: boolean;
  location: AppServiceWorkerLocation;
  navigator: AppServiceWorkerNavigator;
};

export type AppServiceWorkerRegistrationOptions = Partial<AppServiceWorkerEnvironment> & {
  onError?: (error: unknown) => void;
  scope?: string;
  serviceWorkerPath?: string;
};

export async function registerAppServiceWorker(options: AppServiceWorkerRegistrationOptions = {}) {
  let environment: AppServiceWorkerEnvironment = {
    isProduction: options.isProduction ?? import.meta.env.PROD,
    location: options.location ?? window.location,
    navigator: options.navigator ?? window.navigator,
  };

  if (!shouldRegisterAppServiceWorker(environment)) return null;

  try {
    return await environment.navigator.serviceWorker!.register(
      options.serviceWorkerPath ?? appServiceWorkerPath,
      { scope: options.scope ?? appServiceWorkerScope },
    );
  } catch (error) {
    options.onError?.(error);
    return null;
  }
}

export function shouldRegisterAppServiceWorker({
  isProduction,
  location,
  navigator,
}: AppServiceWorkerEnvironment) {
  return Boolean(
    isProduction && navigator.serviceWorker && isServiceWorkerSecureLocation(location),
  );
}

function isServiceWorkerSecureLocation({ hostname, protocol }: AppServiceWorkerLocation) {
  return (
    protocol == "https:" ||
    hostname == "localhost" ||
    hostname == "127.0.0.1" ||
    hostname == "[::1]"
  );
}
