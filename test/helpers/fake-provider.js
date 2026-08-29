function copyRequest(request) {
  return {
    ...request,
    messages: Array.isArray(request?.messages)
      ? request.messages.map((message) => ({
          ...message,
          content: Array.isArray(message?.content)
            ? message.content.map((block) => ({ ...block }))
            : message?.content,
        }))
      : request?.messages,
  };
}

function expandScript(script) {
  const expanded = [];
  for (const step of script) {
    const times = step && Number.isInteger(step.times) ? step.times : 1;
    const response = step && Object.prototype.hasOwnProperty.call(step, "times")
      ? { ...step }
      : step;
    if (response && typeof response === "object") delete response.times;
    for (let index = 0; index < times; index += 1) {
      expanded.push(response);
    }
  }
  return expanded;
}

/**
 * @param {Array<object>} script
 * @returns {{
 *   protocol:"fake",
 *   model:"fake-model",
 *   requests: object[],
 *   calls: object[],
 *   chat: (request:object) => Promise<object>,
 *   chatStream: (request:object) => Promise<object>
 * }}
 */
export function createFakeProvider(script = []) {
  const steps = expandScript(script);
  const requests = [];
  let index = 0;

  const provider = {
    protocol: "fake",
    model: "fake-model",
    requests,
    calls: requests,
    received: requests,

    async chat(request) {
      requests.push(copyRequest(request));
      if (index >= steps.length) {
        throw new Error("Fake provider script exhausted");
      }

      const step = steps[index];
      index += 1;
      if (step && Object.prototype.hasOwnProperty.call(step, "throw")) {
        throw step.throw;
      }
      return {
        content: step?.content ?? [],
        stopReason: step?.stopReason ?? "end_turn",
        ...(step?.usage === undefined ? {} : { usage: step.usage }),
      };
    },

    async chatStream(request) {
      return this.chat(request);
    },
  };
  return provider;
}

export class FakeProvider {
  constructor(script = []) {
    Object.assign(this, createFakeProvider(script));
  }
}

export default createFakeProvider;
