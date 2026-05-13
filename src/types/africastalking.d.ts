declare module 'africastalking' {
  interface AtSms {
    send(payload: {
      to: string | string[];
      message: string;
      from?: string;
    }): Promise<unknown>;
  }
  interface AtClient {
    SMS: AtSms;
  }
  function init(opts: { username: string; apiKey: string }): AtClient;
  export default init;
}
