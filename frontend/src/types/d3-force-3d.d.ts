/**
 * Minimal type declarations for d3-force-3d.
 *
 * d3-force-3d mirrors the d3-force API but adds z-axis support.
 * Nodes gain z/vz/fz properties; forceCenter accepts a third arg; forceZ is new.
 */
declare module 'd3-force-3d' {
  import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force';

  // Re-export the base datum types with z-axis extensions
  export interface SimulationNodeDatum3D extends SimulationNodeDatum {
    z?: number | undefined;
    vz?: number | undefined;
    fz?: number | null | undefined;
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------

  export interface Simulation3D<
    NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D,
    LinkDatum extends SimulationLinkDatum<NodeDatum> = SimulationLinkDatum<NodeDatum>,
  > {
    restart(): this;
    stop(): this;
    tick(iterations?: number): this;
    nodes(): NodeDatum[];
    nodes(nodes: NodeDatum[]): this;
    alpha(): number;
    alpha(alpha: number): this;
    alphaMin(): number;
    alphaMin(min: number): this;
    alphaDecay(): number;
    alphaDecay(decay: number): this;
    alphaTarget(): number;
    alphaTarget(target: number): this;
    velocityDecay(): number;
    velocityDecay(decay: number): this;
    force(name: string): Force3D<NodeDatum, LinkDatum> | undefined;
    force(name: string, force: Force3D<NodeDatum, LinkDatum> | null): this;
    find(x: number, y: number, z?: number, radius?: number): NodeDatum | undefined;
    randomSource(): () => number;
    randomSource(source: () => number): this;
    on(typenames: string): ((...args: unknown[]) => void) | undefined;
    on(typenames: string, listener: ((...args: unknown[]) => void) | null): this;
    numDimensions(): number;
    numDimensions(nDim: 1 | 2 | 3): this;
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface Force3D<
    NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D,
    _LinkDatum extends SimulationLinkDatum<NodeDatum> = SimulationLinkDatum<NodeDatum>,
  > {}

  export function forceSimulation<
    NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D,
    LinkDatum extends SimulationLinkDatum<NodeDatum> = SimulationLinkDatum<NodeDatum>,
  >(nodes?: NodeDatum[]): Simulation3D<NodeDatum, LinkDatum>;

  // ---------------------------------------------------------------------------
  // Forces
  // ---------------------------------------------------------------------------

  export interface ForceLink3D<
    NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D,
    LinkDatum extends SimulationLinkDatum<NodeDatum> = SimulationLinkDatum<NodeDatum>,
  > extends Force3D<NodeDatum, LinkDatum> {
    links(): LinkDatum[];
    links(links: LinkDatum[]): this;
    id(): (node: NodeDatum, i: number, nodesData: NodeDatum[]) => string | number;
    id(id: (node: NodeDatum, i: number, nodesData: NodeDatum[]) => string | number): this;
    distance(): (link: LinkDatum, i: number, links: LinkDatum[]) => number;
    distance(distance: number | ((link: LinkDatum, i: number, links: LinkDatum[]) => number)): this;
    strength(): (link: LinkDatum, i: number, links: LinkDatum[]) => number;
    strength(strength: number | ((link: LinkDatum, i: number, links: LinkDatum[]) => number)): this;
    iterations(): number;
    iterations(iterations: number): this;
  }

  export function forceLink<
    NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D,
    LinkDatum extends SimulationLinkDatum<NodeDatum> = SimulationLinkDatum<NodeDatum>,
  >(links?: LinkDatum[]): ForceLink3D<NodeDatum, LinkDatum>;

  export interface ForceManyBody3D<
    NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D,
  > extends Force3D<NodeDatum> {
    strength(): (d: NodeDatum, i: number, data: NodeDatum[]) => number;
    strength(strength: number | ((d: NodeDatum, i: number, data: NodeDatum[]) => number)): this;
    theta(): number;
    theta(theta: number): this;
    distanceMin(): number;
    distanceMin(distance: number): this;
    distanceMax(): number;
    distanceMax(distance: number): this;
  }

  export function forceManyBody<
    NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D,
  >(): ForceManyBody3D<NodeDatum>;

  export interface ForceCenter3D<
    NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D,
  > extends Force3D<NodeDatum> {
    x(): number;
    x(x: number): this;
    y(): number;
    y(y: number): this;
    z(): number;
    z(z: number): this;
    strength(): number;
    strength(strength: number): this;
  }

  export function forceCenter<NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D>(
    x?: number,
    y?: number,
    z?: number
  ): ForceCenter3D<NodeDatum>;

  export interface ForceCollide3D<
    NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D,
  > extends Force3D<NodeDatum> {
    radius(): (node: NodeDatum, i: number, nodes: NodeDatum[]) => number;
    radius(radius: number | ((node: NodeDatum, i: number, nodes: NodeDatum[]) => number)): this;
    strength(): number;
    strength(strength: number): this;
    iterations(): number;
    iterations(iterations: number): this;
  }

  export function forceCollide<NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D>(
    radius?: number | ((node: NodeDatum, i: number, nodes: NodeDatum[]) => number)
  ): ForceCollide3D<NodeDatum>;

  export interface ForceX3D<
    NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D,
  > extends Force3D<NodeDatum> {
    x(): (d: NodeDatum, i: number, data: NodeDatum[]) => number;
    x(x: number | ((d: NodeDatum, i: number, data: NodeDatum[]) => number)): this;
    strength(): (d: NodeDatum, i: number, data: NodeDatum[]) => number;
    strength(strength: number | ((d: NodeDatum, i: number, data: NodeDatum[]) => number)): this;
  }

  export function forceX<NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D>(
    x?: number | ((d: NodeDatum, i: number, data: NodeDatum[]) => number)
  ): ForceX3D<NodeDatum>;

  export interface ForceY3D<
    NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D,
  > extends Force3D<NodeDatum> {
    y(): (d: NodeDatum, i: number, data: NodeDatum[]) => number;
    y(y: number | ((d: NodeDatum, i: number, data: NodeDatum[]) => number)): this;
    strength(): (d: NodeDatum, i: number, data: NodeDatum[]) => number;
    strength(strength: number | ((d: NodeDatum, i: number, data: NodeDatum[]) => number)): this;
  }

  export function forceY<NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D>(
    y?: number | ((d: NodeDatum, i: number, data: NodeDatum[]) => number)
  ): ForceY3D<NodeDatum>;

  export interface ForceZ3D<
    NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D,
  > extends Force3D<NodeDatum> {
    z(): (d: NodeDatum, i: number, data: NodeDatum[]) => number;
    z(z: number | ((d: NodeDatum, i: number, data: NodeDatum[]) => number)): this;
    strength(): (d: NodeDatum, i: number, data: NodeDatum[]) => number;
    strength(strength: number | ((d: NodeDatum, i: number, data: NodeDatum[]) => number)): this;
  }

  export function forceZ<NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D>(
    z?: number | ((d: NodeDatum, i: number, data: NodeDatum[]) => number)
  ): ForceZ3D<NodeDatum>;

  export interface ForceRadial3D<
    NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D,
  > extends Force3D<NodeDatum> {
    radius(): (d: NodeDatum, i: number, data: NodeDatum[]) => number;
    radius(radius: number | ((d: NodeDatum, i: number, data: NodeDatum[]) => number)): this;
    x(): number;
    x(x: number): this;
    y(): number;
    y(y: number): this;
    z(): number;
    z(z: number): this;
    strength(): (d: NodeDatum, i: number, data: NodeDatum[]) => number;
    strength(strength: number | ((d: NodeDatum, i: number, data: NodeDatum[]) => number)): this;
  }

  export function forceRadial<NodeDatum extends SimulationNodeDatum3D = SimulationNodeDatum3D>(
    radius?: number | ((d: NodeDatum, i: number, data: NodeDatum[]) => number),
    x?: number,
    y?: number,
    z?: number
  ): ForceRadial3D<NodeDatum>;
}
