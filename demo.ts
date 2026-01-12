import { Server } from "denali"

const server = new Server({
  routerType: "path",
})
  .addStaticFiles({
    name: "default-static",
    route: "/static/*",
    root: "./public",
  })
  .addWorker({
    name: "default-worker",
    route: "/",
    scriptUrl: "./worker.ts",
  })

const stop = server.listen(["localhost:3000"])
