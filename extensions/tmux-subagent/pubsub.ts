import * as net from "node:net";
import * as fs from "node:fs";

export type DeliverAs = "steer" | "followUp";

export interface Report {
  status?: string;
  ask?: string;
}

export interface RosterEntry {
  id: string;
  agent: string;
  task: string;
  status: string;
  statusText?: string;
  windowName: string;
}

interface SteerWire {
  type: "steer";
  message: string;
  deliverAs: DeliverAs;
}

interface IdentifyWire {
  type: "identify";
  id: string;
}

interface ReportWire {
  type: "report";
  id: string;
  status?: string;
  ask?: string;
}

interface PeerWire {
  type: "peer";
  from: string;
  to: string;
  message: string;
}

interface RosterWire {
  type: "roster";
  agents: RosterEntry[];
}

type WireMessage = SteerWire | IdentifyWire | ReportWire | PeerWire | RosterWire;

function drainLines(buffer: string, handler: (msg: WireMessage) => void): string {
  const lines = buffer.split("\n");
  const remainder = lines.pop()!;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handler(JSON.parse(line));
    } catch {}
  }
  return remainder;
}

function send(socket: net.Socket, msg: WireMessage): void {
  socket.write(JSON.stringify(msg) + "\n");
}

export class TeamServer {
  private server: net.Server;
  private agents = new Map<string, net.Socket>();
  readonly socketPath: string;

  constructor(
    socketPath: string,
    private onReport?: (agentId: string, report: Report) => void,
    private onPeer?: (from: string, to: string, message: string) => void,
  ) {
    this.socketPath = socketPath;
    try { fs.unlinkSync(socketPath); } catch {}
    this.server = net.createServer((socket) => this.onConnect(socket));
    this.server.listen(socketPath);
    this.server.unref();
  }

  private onConnect(socket: net.Socket): void {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer = drainLines(buffer + chunk.toString(), (msg) => {
        if (msg.type === "identify") {
          this.agents.set(msg.id, socket);
        }
        if (msg.type === "report" && this.onReport) {
          this.onReport(msg.id, { status: msg.status, ask: msg.ask });
        }
        if (msg.type === "peer") {
          this.onPeer?.(msg.from, msg.to, msg.message);
          const target = this.agents.get(msg.to);
          if (target && !target.destroyed) send(target, msg);
        }
      });
    });
    socket.on("close", () => this.removeSocket(socket));
    socket.on("error", () => {});
  }

  private removeSocket(socket: net.Socket): void {
    for (const [id, s] of this.agents) {
      if (s === socket) {
        this.agents.delete(id);
        break;
      }
    }
  }

  steer(agentId: string, message: string, deliverAs: DeliverAs): boolean {
    const socket = this.agents.get(agentId);
    if (!socket || socket.destroyed) return false;
    send(socket, { type: "steer", message, deliverAs });
    return true;
  }

  broadcastRoster(agents: RosterEntry[]): void {
    const msg: RosterWire = { type: "roster", agents };
    for (const socket of this.agents.values()) {
      if (!socket.destroyed) send(socket, msg);
    }
  }

  isConnected(agentId: string): boolean {
    const socket = this.agents.get(agentId);
    return !!socket && !socket.destroyed;
  }

  close(): void {
    for (const socket of this.agents.values()) socket.destroy();
    this.agents.clear();
    this.server.close();
    try { fs.unlinkSync(this.socketPath); } catch {}
  }
}

export class TeamClient {
  private socket: net.Socket;
  private buffer = "";
  private agentId: string;
  private roster: RosterEntry[] = [];

  constructor(
    socketPath: string,
    agentId: string,
    onSteer: (message: string, deliverAs: DeliverAs) => void,
    private onPeer?: (from: string, message: string) => void,
  ) {
    this.agentId = agentId;
    this.socket = net.createConnection(socketPath);
    this.socket.on("connect", () => send(this.socket, { type: "identify", id: agentId }));
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer = drainLines(this.buffer + chunk.toString(), (msg) => {
        if (msg.type === "steer") onSteer(msg.message, msg.deliverAs);
        if (msg.type === "peer") this.onPeer?.(msg.from, msg.message);
        if (msg.type === "roster") this.roster = msg.agents;
      });
    });
    this.socket.on("error", () => {});
    this.socket.unref();
  }

  getRoster(): RosterEntry[] {
    return this.roster;
  }

  setStatus(text: string): void {
    send(this.socket, { type: "report", id: this.agentId, status: text });
  }

  ask(question: string): void {
    send(this.socket, { type: "report", id: this.agentId, ask: question });
  }

  sendPeer(to: string, message: string): void {
    send(this.socket, { type: "peer", from: this.agentId, to, message });
  }

  close(): void {
    this.socket.destroy();
  }
}
