import { db } from "../db.js";

import {
  getPolicyNumberStats,
} from "./policy-numbers.js";

// ---------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------

export type OverallAnalytics = {
  applications: number;

  participants: number;

  paidApplications: number;

  unpaidApplications: number;

  paidParticipants: number;

  individualPolicies: number;

  groupPolicies: number;

  groupParticipants: number;

  issuedPolicies: number;

  issuedParticipants: number;

  revenue: number;

  notExportedApplications: number;

  notExportedParticipants: number;

  viFree: number;

  viIssued: number;

  vkFree: number;

  vkIssued: number;

  conversionPercent: number;

  averageCheck: number;

  averageGroupSize: number;
};

// ---------------------------------------------------------------------
// OVERALL ANALYTICS
// ---------------------------------------------------------------------

export function getOverallAnalytics():
  OverallAnalytics {
  const row =
    db.prepare(`
      SELECT
        COUNT(*) AS applications,

        COALESCE(
          SUM(
            participants_count
          ),
          0
        ) AS participants,

        COALESCE(
          SUM(
            CASE
              WHEN payment_status = 'paid'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS paid_applications,

        COALESCE(
          SUM(
            CASE
              WHEN payment_status != 'paid'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS unpaid_applications,

        COALESCE(
          SUM(
            CASE
              WHEN payment_status = 'paid'
              THEN participants_count
              ELSE 0
            END
          ),
          0
        ) AS paid_participants,

        COALESCE(
          SUM(
            CASE
              WHEN
                application_type = 'individual'
                AND policy_status = 'issued'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS individual_policies,

        COALESCE(
          SUM(
            CASE
              WHEN
                application_type = 'group'
                AND policy_status = 'issued'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS group_policies,

        COALESCE(
          SUM(
            CASE
              WHEN
                application_type = 'group'
                AND policy_status = 'issued'
              THEN participants_count
              ELSE 0
            END
          ),
          0
        ) AS group_participants,

        COALESCE(
          SUM(
            CASE
              WHEN policy_status = 'issued'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS issued_policies,

        COALESCE(
          SUM(
            CASE
              WHEN policy_status = 'issued'
              THEN participants_count
              ELSE 0
            END
          ),
          0
        ) AS issued_participants,

        COALESCE(
          SUM(
            CASE
              WHEN payment_status = 'paid'
              THEN total_amount
              ELSE 0
            END
          ),
          0
        ) AS revenue,

        COALESCE(
          SUM(
            CASE
              WHEN
                policy_status = 'issued'
                AND exported_to_insurer = 0
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS not_exported_applications,

        COALESCE(
          SUM(
            CASE
              WHEN
                policy_status = 'issued'
                AND exported_to_insurer = 0
              THEN participants_count
              ELSE 0
            END
          ),
          0
        ) AS not_exported_participants

      FROM applications
    `).get() as {
      applications: number;

      participants: number;

      paid_applications: number;

      unpaid_applications: number;

      paid_participants: number;

      individual_policies: number;

      group_policies: number;

      group_participants: number;

      issued_policies: number;

      issued_participants: number;

      revenue: number;

      not_exported_applications:
        number;

      not_exported_participants:
        number;
    };

  const viStats =
    getPolicyNumberStats(
      "individual"
    );

  const vkStats =
    getPolicyNumberStats(
      "group"
    );

  const conversionPercent =
    row.applications > 0
      ? Math.round(
          (
            row.paid_applications /
            row.applications
          ) *
            10000
        ) / 100
      : 0;

  const averageCheck =
    row.paid_applications > 0
      ? Math.round(
          row.revenue /
            row.paid_applications
        )
      : 0;

  const averageGroupSize =
    row.group_policies > 0
      ? Math.round(
          (
            row.group_participants /
            row.group_policies
          ) *
            100
        ) / 100
      : 0;

  return {
    applications:
      row.applications || 0,

    participants:
      row.participants || 0,

    paidApplications:
      row.paid_applications || 0,

    unpaidApplications:
      row.unpaid_applications || 0,

    paidParticipants:
      row.paid_participants || 0,

    individualPolicies:
      row.individual_policies || 0,

    groupPolicies:
      row.group_policies || 0,

    groupParticipants:
      row.group_participants || 0,

    issuedPolicies:
      row.issued_policies || 0,

    issuedParticipants:
      row.issued_participants || 0,

    revenue:
      row.revenue || 0,

    notExportedApplications:
      row.not_exported_applications ||
      0,

    notExportedParticipants:
      row.not_exported_participants ||
      0,

    viFree:
      viStats.free,

    viIssued:
      viStats.issued,

    vkFree:
      vkStats.free,

    vkIssued:
      vkStats.issued,

    conversionPercent,

    averageCheck,

    averageGroupSize,
  };
}

// ---------------------------------------------------------------------
// TODAY ANALYTICS
// ---------------------------------------------------------------------

export type TodayAnalytics = {
  applications: number;

  participants: number;

  paidApplications: number;

  issuedPolicies: number;

  revenue: number;
};

export function getTodayAnalytics():
  TodayAnalytics {
  const row =
    db.prepare(`
      SELECT
        COUNT(*) AS applications,

        COALESCE(
          SUM(
            participants_count
          ),
          0
        ) AS participants,

        COALESCE(
          SUM(
            CASE
              WHEN payment_status = 'paid'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS paid_applications,

        COALESCE(
          SUM(
            CASE
              WHEN policy_status = 'issued'
              THEN 1
              ELSE 0
            END
          ),
          0
        ) AS issued_policies,

        COALESCE(
          SUM(
            CASE
              WHEN payment_status = 'paid'
              THEN total_amount
              ELSE 0
            END
          ),
          0
        ) AS revenue

      FROM applications

      WHERE
        date(
          created_at
        ) =
        date(
          'now',
          'localtime'
        )
    `).get() as {
      applications: number;

      participants: number;

      paid_applications: number;

      issued_policies: number;

      revenue: number;
    };

  return {
    applications:
      row.applications || 0,

    participants:
      row.participants || 0,

    paidApplications:
      row.paid_applications || 0,

    issuedPolicies:
      row.issued_policies || 0,

    revenue:
      row.revenue || 0,
  };
}

// ---------------------------------------------------------------------
// FORMAT OVERALL ANALYTICS
// ---------------------------------------------------------------------

export function formatOverallAnalytics(
  analytics:
    OverallAnalytics
): string {
  return [
    "📈 Аналитика",
    "",

    `Заявок: ${analytics.applications}`,

    `Участников: ${analytics.participants}`,

    "",

    `✅ Оплачено заявок: ${analytics.paidApplications}`,

    `⏳ Не оплачено: ${analytics.unpaidApplications}`,

    `👥 Оплачено участников: ${analytics.paidParticipants}`,

    "",

    `📄 Выдано полисов: ${analytics.issuedPolicies}`,

    `👤 Индивидуальных VI: ${analytics.individualPolicies}`,

    `👥 Групповых VK: ${analytics.groupPolicies}`,

    `Участников в групповых: ${analytics.groupParticipants}`,

    "",

    `💰 Выручка: ${analytics.revenue} ₽`,

    `Средний чек: ${analytics.averageCheck} ₽`,

    `Конверсия в оплату: ${analytics.conversionPercent}%`,

    "",

    `📊 Не выгружено страховщику заявок: ${analytics.notExportedApplications}`,

    `Не выгружено участников: ${analytics.notExportedParticipants}`,

    "",

    `🎫 VI свободно: ${analytics.viFree}`,

    `VI использовано: ${analytics.viIssued}`,

    "",

    `🎫 VK свободно: ${analytics.vkFree}`,

    `VK использовано: ${analytics.vkIssued}`,

    "",

    `Средний размер группы: ${analytics.averageGroupSize}`,
  ].join("\n");
}
