import { r as ChatBox } from "./box-DSnEVzkd.js";

//#region src/client.d.ts
/** Hidden this long before the socket is dropped. */
declare const IDLE_MS = 30000;
type HubOptions = {
  /** The hub's page-socket URL (ws:// or wss://, or a path on this origin). */url: string;
  /**
   * This page's label, shown to agents; default: path + (pwa) + user agent.
   * A function is asked again after each client-side navigation.
   */
  label?: string | (() => string); /** Report client-side navigation to the hub ({type:"page"}). Default true. */
  trackPages?: boolean; /** Run code approved agents send (eval scope). Default false. */
  evalCode?: boolean; /** Whether the socket should be up at all (beyond visibility). Default always. */
  wanted?: () => boolean; /** Each eval result, for the site's own logging. */
  onEval?: (r: {
    id: string;
    ok: boolean;
  } & Record<string, unknown>) => void;
};
type HubConnection = {
  /** Re-check visibility and wanted() now (call it when wanted() may have changed). */update(): void;
  close(): void;
};
declare function connectHub(box: ChatBox, opts: HubOptions): HubConnection;
//#endregion
export { HubConnection, HubOptions, IDLE_MS, connectHub };
//# sourceMappingURL=client.d.ts.map