export function getSkillDefinition() {
  return {
    schema_version: 1,
    skill: {
      id: "getTime",
      runtime: "node",
      entrypoint: "skill.mjs",
    },
    tools: [
      {
        name: "getTime",
        description: "获取当前时间，可指定时区",
        inputSchema: {
          type: "object",
          properties: {
            timezone: { type: "string", maxLength: 64 },
          },
          additionalProperties: false,
        },
      },
    ],
  };
}

export async function getTime({ timezone } = {}) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "full",
    timeStyle: "long",
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(new Date());
}
