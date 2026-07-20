export const serviceNowIncidentFields = Object.freeze([
  "sys_id",
  "number",
  "short_description",
  "description",
  "state",
  "priority",
  "impact",
  "urgency",
  "company",
  "caller_id",
  "assigned_to",
  "assignment_group",
  "category",
  "subcategory",
  "opened_at",
  "resolved_at",
  "closed_at",
  "sys_created_on",
  "sys_updated_on",
] as const);

export const serviceNowIncidentFieldList = serviceNowIncidentFields.join(",");
