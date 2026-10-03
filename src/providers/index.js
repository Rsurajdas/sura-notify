import { smsProvider } from "./smsintegra.js";
import { whatsappProvider } from "./chatintegra.js";

export const providers = {
  sms: smsProvider,
  whatsapp: whatsappProvider,
};

export { smsProvider, whatsappProvider };
export * from "./errors.js";
