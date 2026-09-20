import util from "node:util";
import log4js from "log4js";
import { logger } from "./logger";

// Das Adobe-SDK loggt über log4js in eigenem Format direkt auf die Konsole.
// Hier werden diese Meldungen in unseren Logger umgeleitet (gleiches Format/Level, Präfix "sdk:").
// Muss nach dem Import des SDK ausgeführt werden, da das SDK beim Laden selbst konfiguriert.
// Hinweis: die einmalige Zeile "No logging configuration…" schreibt das SDK beim Import unvermeidbar selbst.
const forward = {
  configure: () => (event: log4js.LoggingEvent) => {
    const msg = `sdk: ${util.format(...event.data)}`;
    const level = event.level.levelStr;
    if (level === "ERROR" || level === "FATAL") logger.error(msg);
    else if (level === "WARN") logger.warn(msg);
    else logger.debug(msg);
  },
};

log4js.configure({
  appenders: { forward: { type: forward } },
  categories: { default: { appenders: ["forward"], level: "info" } },
});
