# @mements/sati-orm

A type-safe persistence layer for your zod objects, designed specifically for AI agents but versatile enough for any input/output workflow.

## What

It's a database library that divides everything into input and output tables - a pattern that works remarkably well for many scenarios:

- AI Agents: Store questions and answers with rich metadata
- Task Processing: Schedule tasks (input) and track results (output)
- Financial Systems: Track credits and debits
- Event Systems: Handle triggers and effects

The key innovation is that both input and output are full database tables with complex schemas, not just simple strings. These schemas are generated automatically from your zod definitions, enabling type-safe operations throughout your application.

Important: This is an append-only database by design. It doesn't allow editing previously inserted items, enforcing immutable data patterns.

## Why

- **Type-Safe Objects as Prompts**: Use structured data instead of raw text
- **Rich Response Schemas**: Define exactly what you expect back
- **Long-term Memory**: Built-in semantic search capabilities
- **Distributed Architecture**: Safe and decentralized model inference
- **Agent Persistence**: Maintain agent personality and context across sessions

## Features

- 🔒 Type-safe with Zod schemas
- 🔍 Vector search with sqlite-vec
- 🌐 Remote agent connections
- 🤖 Multiple LLM support (DeepSeek, GPT, Claude, Grok)
- 📝 Automatic schema migration
- 🔎 Flexible querying and recall
- 🏃 High-performance SQLite backend

## Quick Start

```bash
bunx @mements/sati-orm@latest
```

## Usage Examples

### Basic Agent Setup

```typescript
import { Agent } from '@mements/database';
import { z } from 'zod';

// Define your schemas
const inputSchema = z.object({
  question: z.string(),
  context: z.string().optional()
});

const outputSchema = z.object({
  answer: z.string(),
  confidence: z.number(),
  sources: z.array(z.string())
});

// Create an agent
const agent = Agent('my_agent')
  .init(inputSchema, outputSchema);
```

### Inference

```typescript
const result = await agent.infer({
  question: "What is the capital of France?",
  context: "Looking for geographic information"
}, {
  temperature: 0.7,
  model: "deepseek-ai/DeepSeek-R1"
});
```

### Semantic Search

```typescript
const similar = await agent.recall({
  question: "What is Paris known for?"
}, null);
```

### Training/Reinforcement

```typescript
await agent.reinforce({
  question: "What is the capital of France?"
}, {
  answer: "Paris",
  confidence: 0.99,
  sources: ["Wikipedia"]
});
```

### Remote Agents

```typescript
const remoteAgent = Agent('remote_agent')
  .connectRemote('https://api.example.com/agents');
```

## API Reference

### Agent Creation
- `Agent(name: string)`: Create a new agent instance
- `init(fromSchema: ZodObject, toSchema: ZodObject)`: Initialize schemas
- `connectRemote(url: string)`: Connect to remote agent

### Operations
- `infer(input, options?)`: Generate output from input
- `recall(input, output)`: Find similar past interactions
- `reinforce(input, output)`: Train with example pairs
- `find(input?, output?)`: Query stored data
- `store(input, output)`: Store without embeddings
- `addIndex(table, field)`: Create database index
- `edit(id, input, output?)`: Modify stored data
- `delete(id)`: Remove record
- `erase()`: Delete agent and all data

## Environment Variables

```bash
EMBEDDINGS_API_KEY=your_key
EMBEDDINGS_API_URL=https://api.example.com/embeddings
DEEPSEEK_API_KEY=your_key
AGENT_MODE=silent  # Optional: suppress logs
```

## Technical Details

- Uses SQLite with vector extension for efficient similarity search
- Automatically generates SQL schemas from Zod definitions
- Transforms data to/from XML for LLM interactions
- Supports nested object structures and arrays
- Maintains vector embeddings for semantic search
- Provides transaction safety and schema validation

## License

MIT

---

Built with ❤️ by Mements Team