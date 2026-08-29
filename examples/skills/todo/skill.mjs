// ~/.erix/skills/todo/skill.mjs
// Todo 任务管理 skill：数据存 ~/.erix/todos/，按当前工作目录隔离
// 零依赖，仅使用 node:fs / node:os / node:path / node:crypto

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

// ---- 数据文件定位：~/.erix/todos/<basename>-<hash8>.json（按 cwd 隔离）----

function dataFile() {
  const cwd = process.cwd();
  const base = basename(cwd) || 'root';
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 8);
  return join(homedir(), '.erix', 'todos', `${base}-${hash}.json`);
}

// ---- 内部数据读写 ----

function loadTodos() {
  const file = dataFile();
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function saveTodos(todos) {
  const file = dataFile();
  mkdirSync(join(homedir(), '.erix', 'todos'), { recursive: true });
  writeFileSync(file, JSON.stringify(todos, null, 2), 'utf8');
}

// ---- 工具实现 ----

export function todo_add({ text }) {
  const todos = loadTodos();
  const id = todos.length > 0 ? Math.max(...todos.map(t => t.id)) + 1 : 1;
  const item = {
    id,
    text: String(text),
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  todos.push(item);
  saveTodos(todos);
  return { id };
}

export function todo_list({ status } = {}) {
  let todos = loadTodos();
  if (status === 'pending' || status === 'done') {
    todos = todos.filter(t => t.status === status);
  }
  return { todos };
}

export function todo_done({ id }) {
  const todos = loadTodos();
  const item = todos.find(t => t.id === Number(id));
  if (!item) {
    throw new Error(`任务不存在: id=${id}`);
  }
  item.status = 'done';
  saveTodos(todos);
  return { success: true };
}

export function todo_clear() {
  saveTodos([]);
  return { success: true };
}

// ---- Skill 元数据 ----

export function getSkillDefinition() {
  return {
    schema_version: 1,
    skill: {
      id: 'todo',
      runtime: 'node',
      entrypoint: 'skill.mjs'
    },
    tools: [
      {
        name: 'todo_add',
        description: '添加一条待办任务（存 ~/.erix/todos/，按工作目录隔离），返回新任务 id',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '任务内容' }
          },
          required: ['text']
        }
      },
      {
        name: 'todo_list',
        description: '列出当前工作目录的所有待办任务，可按状态过滤',
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['pending', 'done'],
              description: '可选过滤状态：pending 或 done'
            }
          }
        }
      },
      {
        name: 'todo_done',
        description: '将指定 id 的任务标记为完成',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'number', description: '任务 id' }
          },
          required: ['id']
        }
      },
      {
        name: 'todo_clear',
        description: '清空全部任务',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }
    ]
  };
}
