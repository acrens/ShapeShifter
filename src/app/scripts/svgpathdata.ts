import * as Bezier from 'bezier-js';
import { Point, Matrix, Rect } from './mathutil';
import {
  DrawCommand, MoveCommand, LineCommand, QuadraticCurveCommand,
  BezierCurveCommand, EllipticalArcCommand, ClosePathCommand, SubPathCommand, PathCommand
} from './svgcommands';
import * as SvgUtil from './svgutil';
import * as PathParser from './pathparser';

export class SvgPathData extends PathCommand {
  private pathString_: string = '';
  private length_ = 0;
  private bounds_: Rect = null;
  private bezierWrappersMap_: DrawCommandWrapper[][];

  constructor();
  constructor(obj: string);
  constructor(obj: SvgPathData);
  constructor(obj?: any) {
    super();
    if (obj) {
      if (typeof obj === 'string') {
        this.pathString = obj;
      } else if (obj instanceof SvgPathData) {
        this.pathString = obj.pathString;
      }
    }
  }

  get pathString() {
    return this.pathString_;
  }

  set pathString(path: string) {
    this.pathString_ = path;
    this.commands_ = PathParser.parseCommands(path);
    this.updatePathCommand(false);
  }

  get commands() {
    return this.commands_;
  }

  set commands(commands: SubPathCommand[]) {
    this.commands_ = commands;
    this.updatePathCommand(true);
  }

  private updatePathCommand(shouldUpdatePathString: boolean) {
    if (shouldUpdatePathString) {
      this.pathString_ = PathParser.commandsToString(this.commands);
    }
    const {length, bounds, bezierWrappersMap} = this.computeCommandProperties();
    this.length_ = length;
    this.bounds_ = bounds;
    this.bezierWrappersMap_ = bezierWrappersMap;
  }

  interpolate(start: PathCommand, end: PathCommand, fraction: number) {
    if (super.interpolate(start, end, fraction)) {
      // TODO(alockwood): avoid doing these hacks
      this.commands = this.commands;
      return true;
    }
    return false;
  }

  transform(transforms: Matrix[]) {
    super.transform(transforms);
    // TODO(alockwood): only recalculate bounds and length when necessary
    this.commands = this.commands;
  }

  reverse() {
    this.commands.forEach(c => c.reverse());
    this.commands = this.commands;
  }

  shiftBack() {
    this.commands.forEach(c => c.shiftBack());
    this.commands = this.commands;
  }

  shiftForward() {
    this.commands.forEach(c => c.shiftForward());
    this.commands = this.commands;
  }

  get length() {
    return this.length_;
  }

  toString() {
    return this.pathString;
  }

  project(point: Point): ProjectionInfo | null {
    const bezierWrappers: { subPathCommandIndex: number, commandIndex: number, bw: DrawCommandWrapper }[] = [];
    this.bezierWrappersMap_.forEach((bws, subPathCommandIndex) => {
      bws.forEach((bw, commandIndex) => {
        bezierWrappers.push({ subPathCommandIndex, commandIndex, bw });
      });
    });
    return bezierWrappers.map(({subPathCommandIndex, commandIndex, bw}) => {
      return { subPathCommandIndex, commandIndex, projection: bw.project(point) };
    }).filter(({ subPathCommandIndex, commandIndex, projection }) => !!projection)
      .reduce((prev, curr) => {
        if (!prev || !curr) {
          return prev ? prev : curr;
        }
        return curr.projection.d < prev.projection.d ? curr : prev;
      }, null);
  }

  split(subPathCommandIndex: number, commandIndex: number, t: number) {
    const bezierWrapper = this.bezierWrappersMap_[subPathCommandIndex][commandIndex];
    const {left, right} = bezierWrapper.split(t);
    const leftStartPoint = new Point(left.points[0].x, left.points[0].y);
    const leftEndPoint = new Point(left.points[left.points.length - 1].x, left.points[left.points.length - 1].y);
    const rightStartPoint = new Point(right.points[0].x, right.points[0].y);
    const rightEndPoint = new Point(right.points[right.points.length - 1].x, right.points[right.points.length - 1].y);
    const cmd = bezierWrapper.command;
    let leftCmd: DrawCommand;
    let rightCmd: DrawCommand;
    if (cmd instanceof LineCommand) {
      leftCmd = new LineCommand(leftStartPoint, leftEndPoint);
      rightCmd = new LineCommand(rightStartPoint, rightEndPoint);
    } else if (cmd instanceof ClosePathCommand) {
      leftCmd = new LineCommand(leftStartPoint, leftEndPoint);
      rightCmd = new ClosePathCommand(rightStartPoint, rightEndPoint);
    } else if (cmd instanceof QuadraticCurveCommand) {
      leftCmd = new QuadraticCurveCommand(
        new Point(left.points[0].x, left.points[0].y),
        new Point(left.points[1].x, left.points[1].y),
        new Point(left.points[2].x, left.points[2].y));
      rightCmd = new QuadraticCurveCommand(
        new Point(right.points[0].x, right.points[0].y),
        new Point(right.points[1].x, right.points[1].y),
        new Point(right.points[2].x, right.points[2].y));
    } else if (cmd instanceof BezierCurveCommand) {
      leftCmd = new BezierCurveCommand(
        new Point(left.points[0].x, left.points[0].y),
        new Point(left.points[1].x, left.points[1].y),
        new Point(left.points[2].x, left.points[2].y),
        new Point(left.points[3].x, left.points[3].y));
      rightCmd = new BezierCurveCommand(
        new Point(right.points[0].x, right.points[0].y),
        new Point(right.points[1].x, right.points[1].y),
        new Point(right.points[2].x, right.points[2].y),
        new Point(right.points[3].x, right.points[3].y));
    } else if (cmd instanceof EllipticalArcCommand) {
      throw new Error('TODO: implement split for ellpitical arcs');
    }
    const commands: DrawCommand[] = this.commands[subPathCommandIndex].commands;
    commands.splice(commandIndex, 1, leftCmd, rightCmd);
    this.commands = this.commands;
  }

  private computeCommandProperties() {
    let length = 0;
    const bounds = new Rect(Infinity, Infinity, -Infinity, -Infinity);
    const bezierWrappersMap: DrawCommandWrapper[][] = [];

    const expandBounds_ = (x: number, y: number) => {
      bounds.l = Math.min(x, bounds.l);
      bounds.t = Math.min(y, bounds.t);
      bounds.r = Math.max(x, bounds.r);
      bounds.b = Math.max(y, bounds.b);
    };

    const expandBoundsToBezier_ = bez => {
      const bbox = bez.bbox();
      expandBounds_(bbox.x.min, bbox.y.min);
      expandBounds_(bbox.x.max, bbox.y.min);
      expandBounds_(bbox.x.min, bbox.y.max);
      expandBounds_(bbox.x.max, bbox.y.max);
    };

    let firstPoint = null;
    let currentPoint = new Point(0, 0);

    this.commands.forEach((subPathCommand, subPathCmdIndex) => {
      const bezierWrappers = [];
      subPathCommand.commands.forEach((command, drawCmdIndex) => {
        if (command instanceof MoveCommand) {
          const nextPoint = command.points[1];
          if (!firstPoint) {
            firstPoint = nextPoint;
          }
          currentPoint = nextPoint;
          expandBounds_(nextPoint.x, nextPoint.y);
          bezierWrappers.push(new DrawCommandWrapper(this, subPathCmdIndex, drawCmdIndex));
        } else if (command instanceof LineCommand) {
          const nextPoint = command.points[1];
          length += nextPoint.distanceTo(currentPoint);
          bezierWrappers.push(new DrawCommandWrapper(
            this, subPathCmdIndex, drawCmdIndex, new Bezier(currentPoint, currentPoint, nextPoint, nextPoint)));
          currentPoint = nextPoint;
          expandBounds_(nextPoint.x, nextPoint.y);
        } else if (command instanceof ClosePathCommand) {
          if (firstPoint) {
            length += firstPoint.distanceTo(currentPoint);
            bezierWrappers.push(new DrawCommandWrapper(
              this, subPathCmdIndex, drawCmdIndex, new Bezier(currentPoint, currentPoint, firstPoint, firstPoint)));
          }
          firstPoint = null;
        } else if (command instanceof BezierCurveCommand) {
          const points = command.points;
          const bez = new Bezier(currentPoint, points[1], points[2], points[3]);
          bezierWrappers.push(new DrawCommandWrapper(this, subPathCmdIndex, drawCmdIndex, bez));
          length += bez.length();
          currentPoint = points[3];
          expandBoundsToBezier_(bez);
        } else if (command instanceof QuadraticCurveCommand) {
          const points = command.points;
          const bez = new Bezier(currentPoint, points[1], points[2]);
          bezierWrappers.push(new DrawCommandWrapper(this, subPathCmdIndex, drawCmdIndex, bez));
          length += bez.length();
          currentPoint = points[2];
          expandBoundsToBezier_(bez);
        } else if (command instanceof EllipticalArcCommand) {
          const args = command.args;
          const [currentPointX, currentPointY,
            rx, ry, xAxisRotation,
            largeArcFlag, sweepFlag,
            tempPoint1X, tempPoint1Y] = args;

          if (currentPointX === tempPoint1X && currentPointY === tempPoint1Y) {
            // degenerate to point (0 length)
            bezierWrappers.push(new DrawCommandWrapper(this, subPathCmdIndex, drawCmdIndex));
            return;
          }

          if (rx === 0 || ry === 0) {
            // degenerate to line
            const nextPoint = new Point(tempPoint1X, tempPoint1Y);
            length += new Point(currentPointX, currentPointY).distanceTo(nextPoint);
            expandBounds_(tempPoint1X, tempPoint1Y);
            bezierWrappers.push(new DrawCommandWrapper(
              this, subPathCmdIndex, drawCmdIndex, new Bezier(currentPoint, currentPoint, nextPoint, nextPoint)));
            currentPoint = nextPoint;
            return;
          }

          const bezierCoords = SvgUtil.arcToBeziers(
            currentPointX, currentPointY,
            rx, ry, xAxisRotation,
            largeArcFlag, sweepFlag,
            tempPoint1X, tempPoint1Y);

          const arcBeziers: Bezier[] = [];
          for (let i = 0; i < bezierCoords.length; i += 8) {
            const bez = new Bezier(
              currentPoint.x, currentPoint.y,
              bezierCoords[i + 2], bezierCoords[i + 3],
              bezierCoords[i + 4], bezierCoords[i + 5],
              bezierCoords[i + 6], bezierCoords[i + 7]);
            arcBeziers.push(bez);
            length += bez.length();
            currentPoint = new Point(bezierCoords[i + 6], bezierCoords[i + 7]);
            expandBoundsToBezier_(bez);
          }
          bezierWrappers.push(new DrawCommandWrapper(this, subPathCmdIndex, drawCmdIndex, ...arcBeziers));
          currentPoint = new Point(tempPoint1X, tempPoint1Y);
        }
      });
      bezierWrappersMap.push(bezierWrappers);
    });

    return { length, bounds, bezierWrappersMap };
  }
}

/** Wraps around the bezier curves associated with a draw command. */
class DrawCommandWrapper {
  readonly beziers: Bezier[];

  constructor(
    public readonly pathCommand: PathCommand,
    public readonly subPathCommandIndex: number,
    public readonly drawCommandIndex: number,
    ...beziers: Bezier[]) {
    this.beziers = beziers;
  }

  project(point: Point): Projection | null {
    if (!this.beziers.length) {
      return null;
    }
    return this.beziers
      .map(bez => bez.project(point))
      .reduce((prev, curr) => prev.d < curr.d ? prev : curr);
  }

  split(t: number): Split | null {
    if (!this.beziers.length) {
      return null;
    }
    if (this.command instanceof EllipticalArcCommand) {
      throw new Error('TODO: implement split support for elliptical arcs');
    }
    return this.beziers[0].split(t);
  }

  get command() {
    return this.pathCommand
      .commands[this.subPathCommandIndex]
      .commands[this.drawCommandIndex];
  }
}

// TODO(alockwood): figure out a better way to declare these types...

export type Projection = {
  x: number;
  y: number;
  t: number;
  d: number;
};

export type ProjectionInfo = {
  subPathCommandIndex: number;
  commandIndex: number;
  projection: Projection;
};

interface Split {
  left: Bezier;
  right: Bezier;
}

type Bezier = {
  constructor(points: Point[]);
  constructor(coords: number[]);
  constructor(
    x1: number, y1: number,
    x2: number, y2: number,
    x3: number, y3: number,
    x4?: number, y4?: number);
  constructor(p1: Point, p2: Point, p3: Point, p4?: Point);
  points: Point[];
  length(): number;
  project(point: Point): Projection;
  split(t: number): Split;
};
