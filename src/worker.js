/**
 * Bluestout Sections Library — MCP Server
 * Cloudflare Worker
 */

const GITHUB_REPO = "bluestout/bluestout-sections-suite";
const GITHUB_BRANCH = "live";
const GITHUB_API = "https://api.github.com";

// ─── GitHub Helpers ───────────────────────────────────────────────────────────

async function fetchSectionsList(token) {
  const res = await fetch(
    `${GITHUB_API}/repos/${GITHUB_REPO}/contents/sections?ref=${GITHUB_BRANCH}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Bluestout-MCP",
      },
    }
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const files = await res.json();
  return files
    .filter((f) => f.type === "file")
    .map((f) => f.name);
}

async function fetchSectionContent(filename, token) {
  const res = await fetch(
    `${GITHUB_API}/repos/${GITHUB_REPO}/contents/sections/${filename}?ref=${GITHUB_BRANCH}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Bluestout-MCP",
      },
    }
  );
  if (!res.ok) throw new Error(`Section not found: ${filename}`);
  const data = await res.json();
  return atob(data.content.replace(/\n/g, ""));
}

// ─── MCP Protocol ─────────────────────────────────────────────────────────────

function mcpResponse(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function mcpError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "list_sections",
    description:
      "List all available pre-built sections in the Bluestout sections library. Always call this first to see what sections are available.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_section",
    description:
      "Get the full code of a specific section from the Bluestout library. Use this to read a section before adding it to a project.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "The section filename, e.g. announcement-bar.liquid",
        },
      },
      required: ["filename"],
    },
  },
  {
    name: "add_section_to_project",
    description:
      "Fetch a section from the Bluestout library and return its content so it can be added to the current Shopify project's /sections/ folder. After getting the content, save it to the project and adapt colors/fonts to match the theme.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "The section filename to add, e.g. announcement-bar.liquid",
        },
      },
      required: ["filename"],
    },
  },
];

// ─── Tool Handlers ────────────────────────────────────────────────────────────

async function handleTool(name, input, token) {
  switch (name) {
    case "list_sections": {
      const sections = await fetchSectionsList(token);
      return {
        content: [
          {
            type: "text",
            text:
              sections.length > 0
                ? `Available sections in Bluestout library (${sections.length}):\n\n` +
                sections.map((s) => `• ${s}`).join("\n") +
                `\n\nUse get_section or add_section_to_project to work with any of these.`
                : "No sections found in the library yet.",
          },
        ],
      };
    }

    case "get_section": {
      const { filename } = input;
      const content = await fetchSectionContent(filename, token);
      return {
        content: [
          {
            type: "text",
            text: `Content of ${filename}:\n\n${content}`,
          },
        ],
      };
    }

    case "add_section_to_project": {
      const { filename } = input;
      const content = await fetchSectionContent(filename, token);
      return {
        content: [
          {
            type: "text",
            text:
              `✅ Section ready to add: ${filename}\n\n` +
              `INSTRUCTIONS:\n` +
              `1. Save this content to sections/${filename} in the current project\n` +
              `2. Check settings_schema.json for existing color/font settings\n` +
              `3. Update the section schema defaults to match the theme\n` +
              `4. Confirm to the user once done\n\n` +
              `--- SECTION CONTENT ---\n\n${content}`,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP Request Handler ──────────────────────────────────────────────────────

async function handleMCPRequest(body, token) {
  const { method, id, params } = body;

  try {
    switch (method) {
      case "initialize":
        return mcpResponse(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "bluestout-sections",
            version: "1.0.0",
          },
        });

      case "tools/list":
        return mcpResponse(id, { tools: TOOLS });

      case "tools/call": {
        const { name, arguments: input } = params;
        const result = await handleTool(name, input || {}, token);
        return mcpResponse(id, result);
      }

      case "notifications/initialized":
        return null;

      default:
        return mcpError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return mcpError(id, -32603, err.message);
  }
}

// ─── Main Worker ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", server: "bluestout-sections-mcp" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // MCP endpoint
    if (url.pathname === "/mcp" && request.method === "POST") {
      const token = env.GITHUB_TOKEN;
      if (!token) {
        return new Response(
          JSON.stringify({ error: "GITHUB_TOKEN not configured" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const body = await request.json();
      const response = await handleMCPRequest(body, token);

      if (!response) {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      return new Response(JSON.stringify(response), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};