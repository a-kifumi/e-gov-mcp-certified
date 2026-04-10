import dotenv from "dotenv";
import path from "path";
import { logServerError } from "./core.ts";
import { startServer } from "./http.ts";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

process.on("unhandledRejection", (reason) => {
  logServerError("process.unhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
  logServerError("process.uncaughtException", error);
});

startServer();
