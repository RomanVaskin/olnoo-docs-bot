// ---------------------------------------------------------------------
// DOCUMENT DATA
// ---------------------------------------------------------------------

export type PassportData = {
  documentType?: string;

  lastName?: string;
  firstName?: string;
  middleName?: string;

  birthDate?: string;
  birthPlace?: string;
  gender?: string;

  passportSeries?: string;
  passportNumber?: string;

  issueDate?: string;
  issuedBy?: string;
  departmentCode?: string;
};

// ---------------------------------------------------------------------
// DOCUMENT EDITING
// ---------------------------------------------------------------------

export type EditableField =
  | "lastName"
  | "firstName"
  | "middleName"
  | "birthDate"
  | "birthPlace"
  | "gender"
  | "passportSeries"
  | "passportNumber"
  | "issueDate"
  | "issuedBy"
  | "departmentCode";

// ---------------------------------------------------------------------
// APPLICATION TYPES
// ---------------------------------------------------------------------

export type ApplicationType =
  | "individual"
  | "group";

export type PolicyPeriod =
  | "day"
  | "month"
  | "year";

export type PaymentStatus =
  | "pending"
  | "paid"
  | "cancelled"
  | "refunded";

export type PolicyStatus =
  | "waiting"
  | "generating"
  | "issued"
  | "error";

export type PolicyNumberStatus =
  | "available"
  | "reserved"
  | "issued";

export type ApplicationSource = "telegram" | "web";
export type Insurer = "ingos" | "reso";
export type InsurancePolicyType = "VI" | "VK" | "SYS";

// ---------------------------------------------------------------------
// USER SESSION
// ---------------------------------------------------------------------

export type UserMode =
  | "idle"
  | "selecting_tournament"
  | "uploading_individual"
  | "uploading_group"
  | "editing"
  | "selecting_period"
  | "waiting_payment";

export type UserState = {
  mode: UserMode;

  tournamentId?: number;

  applicationType?: ApplicationType;

  currentParticipant?: PassportData;

  editingField?: EditableField;

  groupParticipants?: PassportData[];

  selectedPeriod?: PolicyPeriod;

  applicationId?: number;
};

// ---------------------------------------------------------------------
// DATABASE MODELS
// ---------------------------------------------------------------------

export type Tournament = {
  id: number;
  name: string;
  eventDate: string | null;
  isActive: number;
  createdAt: string;
};

export type UserProfile = {
  telegramUserId: string;

  telegramUsername: string | null;

  telegramName: string | null;

  email: string | null;

  createdAt: string;

  updatedAt: string;
};

export type Application = {
  id: number;

  submittedByUserId: string;

  tournamentId: number;

  applicationType: ApplicationType;

  policyPeriod: PolicyPeriod | null;

  participantsCount: number;

  pricePerPerson: number;

  totalAmount: number;

  paymentStatus: PaymentStatus;

  paidAt: string | null;

  policyNumber: string | null;

  policyDate: string | null;

  policyStartDate: string | null;

  policyEndDate: string | null;

  policyStatus: PolicyStatus;

  issuedAt: string | null;

  exportedToInsurer: number;

  exportBatchId: string | null;

  createdAt: string;
  source: ApplicationSource;
  insurer: Insurer | null;
  insurancePolicyType: InsurancePolicyType | null;
  sport: string | null;
  insuranceAmount: number | null;
};

export type Participant = {
  id: number;

  applicationId: number;

  lastName: string;
  firstName: string;
  middleName: string;

  birthDate: string;
  birthPlace: string;
  gender: string;

  passportSeries: string;
  passportNumber: string;

  issueDate: string;
  issuedBy: string;
  departmentCode: string;

  createdAt: string;
};
