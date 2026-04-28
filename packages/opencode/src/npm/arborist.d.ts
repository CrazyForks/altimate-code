// altimate_change start — minimal types for @npmcli/arborist (no published @types pkg)
declare module "@npmcli/arborist" {
  export interface ArboristOptions {
    path: string
    binLinks?: boolean
    progress?: boolean
    savePrefix?: string
    ignoreScripts?: boolean
  }

  export interface EdgeOut {
    to?: { name: string; path: string } | null
  }

  export interface ArboristNode {
    edgesOut: Map<string, EdgeOut>
  }

  export interface ReifyOptions {
    add?: string[]
    save?: boolean
    saveType?: "prod" | "dev" | "optional" | "peer" | "peerOptional"
  }

  export class Arborist {
    constructor(options: ArboristOptions)
    loadVirtual(): Promise<ArboristNode>
    reify(options?: ReifyOptions): Promise<ArboristNode>
  }
}
// altimate_change end
