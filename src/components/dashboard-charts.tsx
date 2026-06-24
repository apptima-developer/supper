"use client";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const colors = ["#0a84ff", "#20c9b7", "#8b5cf6", "#f59e0b", "#ef5da8", "#64748b"];
const tipStyle = { fontSize: 11, borderRadius: 12, borderColor: "#cfe8f7", boxShadow: "0 14px 36px rgba(35,77,112,.12)" };

function shortLabel(value: string) {
  return value.length > 18 ? `${value.slice(0, 17)}…` : value;
}

export function MdChart({ data, color = "#0a84ff" }: { data: { name: string; value: number }[]; color?: string }) {
  return (
    <div className="h-[250px] min-h-[250px] min-w-0 w-full">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={250}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 20, top: 6, bottom: 6 }}>
          <CartesianGrid stroke="#e3f0fb" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
          <YAxis dataKey="name" type="category" width={112} tickFormatter={shortLabel} tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={tipStyle} />
          <Bar dataKey="value" fill={color} radius={[0, 7, 7, 0]} barSize={15} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function OwnerTicketChart({
  data,
}: {
  data: { name: string; onTrack: number; dueSoon: number; overdue: number }[];
}) {
  return (
    <div className="h-[280px] min-h-[280px] min-w-0 w-full">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={280}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 20, top: 6, bottom: 6 }}>
          <CartesianGrid stroke="#e3f0fb" horizontal={false} />
          <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
          <YAxis dataKey="name" type="category" width={112} tickFormatter={shortLabel} tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={tipStyle} />
          <Legend wrapperStyle={{ fontSize: 10 }} iconType="circle" />
          <Bar dataKey="onTrack" name="On track" stackId="tickets" fill="#0a84ff" radius={[0, 0, 0, 0]} barSize={15} />
          <Bar dataKey="dueSoon" name="Due soon" stackId="tickets" fill="#f59e0b" radius={[0, 0, 0, 0]} barSize={15} />
          <Bar dataKey="overdue" name="Overdue" stackId="tickets" fill="#ef4444" radius={[0, 7, 7, 0]} barSize={15} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function AgingChart({ data }: { data: { name: string; value: number }[] }) {
  return (
    <div className="h-[250px] min-h-[250px] min-w-0 w-full">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={250}>
        <BarChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
          <CartesianGrid stroke="#e3f0fb" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={tipStyle} />
          <Bar dataKey="value" fill="#8b5cf6" radius={[7, 7, 0, 0]} barSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StatusChart({ data }: { data: { name: string; value: number }[] }) {
  return (
    <div className="h-[250px] min-h-[250px] min-w-0 w-full">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={250}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={58} outerRadius={82} paddingAngle={3}>
            {data.map((_, index) => <Cell key={index} fill={colors[index % colors.length]} />)}
          </Pie>
          <Tooltip contentStyle={tipStyle} />
          <Legend wrapperStyle={{ fontSize: 10 }} iconType="circle" />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
