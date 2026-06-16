/**
 * Barrel re-export for the UI Motion Grabber shared module.
 *
 * Importers across the Service_Worker and Popup_UI can pull every shared
 * data-model shape and the Message_Channel definitions from `src/shared`.
 */

export * from "./types";
export * from "./messages";
