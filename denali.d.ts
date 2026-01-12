
declare module "denali" {

  /**
   * Middlewares used to process requests and responses for each application.
   */
  interface MiddlewareOptions {
    // TODO: implement these
    // encode?: EncodeOptions
    // basicAuth?: BasicAuthOptions
  }

  /**
   * General options for each application.
   */
  interface ApplicationOptions {
    /** 
     * Unique name for the application.
     */
    name: string
    /** 
     * Route data used to match the application.
     * The content varies based on the router type of the server.
     */
    route: string
  }

  interface ReverseProxyApplicationOptions extends ApplicationOptions, MiddlewareOptions {
    upstreams: string[]
  }

  interface StaticFilesApplicationOptions extends ApplicationOptions, MiddlewareOptions {
    root: string
  }

  interface WorkerApplicationOptions extends ApplicationOptions, MiddlewareOptions {
    scriptUrl: string
    assetsRoot?: string
    notFoundHandler?: "script" | "single-page-application" | "404-page"
  }


  type ServerRouterType = "domain" | "path" | "expression" | "script"

  interface ServerOptions {
    routerType: ServerRouterType
  }

  export class Server {

    constructor(options: ServerOptions)

    /**
     * Add a reverse proxy application to the server.
     * All add* methods can be called at runtime to dynamically add applications to the server.
     */
    addReverseProxy(options: ReverseProxyApplicationOptions): this

    /**
     * Add a static files application to the server.
     * All add* methods can be called at runtime to dynamically add applications to the server.
     */
    addStaticFiles(options: StaticFilesApplicationOptions): this

    /**
     * Add a worker application to the server.
     * All add* methods can be called at runtime to dynamically add applications to the server.
     */
    addWorker(options: WorkerApplicationOptions): this

    /**
     * Remove an application from the server.
     * This can be called at runtime to dynamically remove applications from the server.
     */
    removeApplication(name: string): this


    /**
     * Start the server and listen for incoming requests on the given addresses.
     * Returns a function to stop the server.
     */
    listen(addresses: string[]): () => void

  }
}
