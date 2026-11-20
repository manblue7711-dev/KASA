create table students (
  id bigint generated always as identity primary key,
  phone text not null,
  group_name text not null,
  opted_out boolean not null default false,
  unique (phone, group_name)
);
-- RLS on with no policies: only your server key can read or write.
alter table students enable row level security;

-- Send history (run this part if you already ran the first part)
create table sends (
  id bigint generated always as identity primary key,
  rep text not null,
  group_name text not null,
  message text not null,
  recipients int not null,
  created_at timestamptz not null default now()
);
alter table sends enable row level security;
