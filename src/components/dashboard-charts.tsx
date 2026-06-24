"use client";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const colors = ["#0a84ff", "#20c9b7", "#8b5cf6", "#f59e0b", "#ef5da8", "#64748b"];
const tipStyle = { fontSize: 11, borderRadius: 12, borderColor: "#cfe8f7", boxShadow: "0 14px 36px rgba(35,77,112,.12)" };

export function MdChart({ data }: { data: { name: string; value: number }[] }) {
  return (
    <div className="h-[230px] min-h-[230px] min-w-0 w-full">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={230}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
          <CartesianGrid stroke="#e3f0fb" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
          <YAxis dataKey="name" type="category" width={86} tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
          <Tooltip contentStyle={tipStyle} />
          <Bar dataKey="value" fill="#0a84ff" radius={[0, 7, 7, 0]} barSize={16} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StatusChart({ data }: { data: { name: string; value: number }[] }) {
  return (
    <div className="h-[230px] min-h-[230px] min-w-0 w-full">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={230}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={52} outerRadius={78} paddingAngle={3}>
            {data.map((_, index) => <Cell key={index} fill={colors[index % colors.length]} />)}
          </Pie>
          <Tooltip contentStyle={tipStyle} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
