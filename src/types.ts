/** Pads Noah's Fixtr server already parsed from KiCad. Positions are millimetres. */
export type Pad = {
  ref: string;
  pad: string;
  net: string;
  x?: number;
  y?: number;
};

export type Board = {
  pads: Pad[];
};

export type Reading = {
  target?: string;
  net?: string;
  value: number;
  unit?: string;
};

export type HypothesisStatus = "active" | "ruled_out" | "confirmed";

export type Hypothesis = {
  id: string;
  title: string;
  detail: string;
  confidence: number;
  status: HypothesisStatus;
};

export type ProbeLead = "red" | "black";
export type ProbeKind = "probe" | "connector" | "button" | "pin1";
export type ActionType = "probe" | "command" | "reflash" | "physical" | "question";
export type FaultClass = "hardware" | "firmware" | "plan" | "setup" | "unknown";

export type ProbePoint = {
  target: string;
  net: string;
  lead: ProbeLead;
  kind: ProbeKind;
  label: string;
  x?: number;
  y?: number;
};

export type NextAction = {
  title: string;
  body: string;
  type: ActionType;
  probes: ProbePoint[];
  inputLabel?: string;
  unit?: string;
  command?: string;
};

export type Observation = {
  title: string;
  body: string;
  reasoning?: string;
};

export type Resolved = {
  class: FaultClass;
  summary: string;
};

/** Object Fixtr's applyStep already accepts. One of next_action or resolved. */
export type Step = {
  observation: Observation;
  hypotheses: Hypothesis[];
  evidence_add: string[];
  next_action?: NextAction;
  resolved?: Resolved;
};

export type Constraints = {
  /** When false, ohms/continuity is allowed. Voltage checks need power. */
  powered?: boolean;
  allowOptionBytes?: boolean;
  allowFuses?: boolean;
  allowOtp?: boolean;
  allowMassErase?: boolean;
};

export type FailedTest = {
  name?: string;
  net?: string;
  min?: number;
  max?: number;
  unit?: string;
};

export type DecideInput = {
  symptom: string;
  board: Board;
  readings?: Reading[];
  /** Latest typed reading, if the caller sends one object instead of the list. */
  reading?: Reading;
  hypotheses?: Hypothesis[];
  evidence?: string[];
  constraints?: Constraints;
  failedTest?: FailedTest;
};
