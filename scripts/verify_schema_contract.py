#!/usr/bin/env python3
"""Verify safety/correctness-critical PostgreSQL schema invariants.

The contract is intentionally narrower than a full schema dump. It tracks objects whose
absence or mutation can change correctness, authorization, idempotency, or worker safety.

Usage:
  python3 scripts/verify_schema_contract.py \
    --database-url postgresql://... \
    --contract supabase/schema-contract.json

The database role only needs catalog visibility plus CONNECT. No writes are performed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def normalize_sql(value: str | None) -> str:
    if not value:
        return ""
    # Catalog printers may add quoting/parentheses/spacing across PostgreSQL versions.
    # Keep punctuation intact, but normalize case, identifier quotes and whitespace.
    value = value.replace('"', "").lower()
    return re.sub(r"\s+", " ", value).strip()


def parse_bool(value: str) -> bool:
    return value.strip().lower() in {"t", "true", "1", "yes"}


class ContractVerifier:
    def __init__(self, database_url: str, contract: dict[str, Any]) -> None:
        self.database_url = database_url
        self.contract = contract
        self.failures: list[str] = []

    def query(self, sql: str) -> str:
        cmd = [
            "psql",
            self.database_url,
            "-X",
            "-A",
            "-t",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            sql,
        ]
        result = subprocess.run(cmd, text=True, capture_output=True)
        if result.returncode != 0:
            raise RuntimeError(
                "psql query failed:\n"
                + sql
                + "\n--- stderr ---\n"
                + result.stderr.strip()
            )
        return result.stdout.strip()

    def fail(self, message: str) -> None:
        self.failures.append(message)

    def check_contains(self, label: str, actual: str, fragments: list[str]) -> None:
        normalized = normalize_sql(actual)
        for fragment in fragments:
            if normalize_sql(fragment) not in normalized:
                self.fail(f"{label}: missing expected fragment: {fragment!r}")

    def verify_indexes(self) -> None:
        for item in self.contract.get("indexes", []):
            schema = item.get("schema", "public")
            table = item["table"]
            name = item["name"]
            row = self.query(
                "SELECT indexdef FROM pg_indexes "
                f"WHERE schemaname={sql_literal(schema)} "
                f"AND tablename={sql_literal(table)} "
                f"AND indexname={sql_literal(name)};"
            )
            must_exist = item.get("must_exist", True)
            label = f"index {schema}.{name}"
            if must_exist and not row:
                self.fail(f"{label}: missing")
                continue
            if not must_exist and row:
                self.fail(f"{label}: exists but contract requires it absent")
                continue
            if row:
                self.check_contains(label, row, item.get("definition_contains", []))

    def verify_constraints(self) -> None:
        for item in self.contract.get("constraints", []):
            schema = item.get("schema", "public")
            table = item["table"]
            name = item["name"]
            row = self.query(
                "SELECT pg_get_constraintdef(c.oid) "
                "FROM pg_constraint c "
                "JOIN pg_class t ON t.oid=c.conrelid "
                "JOIN pg_namespace n ON n.oid=t.relnamespace "
                f"WHERE n.nspname={sql_literal(schema)} "
                f"AND t.relname={sql_literal(table)} "
                f"AND c.conname={sql_literal(name)};"
            )
            label = f"constraint {schema}.{table}.{name}"
            if not row:
                self.fail(f"{label}: missing")
                continue
            self.check_contains(label, row, item.get("definition_contains", []))

    def verify_columns(self) -> None:
        for item in self.contract.get("columns", []):
            schema = item.get("schema", "public")
            table = item["table"]
            name = item["name"]
            row = self.query(
                "SELECT json_build_object("
                "'type', format_type(a.atttypid, a.atttypmod), "
                "'not_null', a.attnotnull, "
                "'default', pg_get_expr(d.adbin, d.adrelid)"
                ")::text "
                "FROM pg_attribute a "
                "JOIN pg_class t ON t.oid=a.attrelid "
                "JOIN pg_namespace n ON n.oid=t.relnamespace "
                "LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum "
                f"WHERE n.nspname={sql_literal(schema)} "
                f"AND t.relname={sql_literal(table)} "
                f"AND a.attname={sql_literal(name)} "
                "AND a.attnum > 0 AND NOT a.attisdropped;"
            )
            label = f"column {schema}.{table}.{name}"
            if not row:
                self.fail(f"{label}: missing")
                continue
            info = json.loads(row)
            if "type" in item and normalize_sql(info.get("type")) != normalize_sql(item["type"]):
                self.fail(
                    f"{label}: type {info.get('type')!r} != expected {item['type']!r}"
                )
            if "not_null" in item and bool(info.get("not_null")) != bool(item["not_null"]):
                self.fail(
                    f"{label}: not_null={info.get('not_null')} != expected {item['not_null']}"
                )
            if item.get("default_contains"):
                self.check_contains(label + " default", info.get("default") or "", item["default_contains"])

    def function_oid(self, schema: str, name: str, identity_args: str) -> str:
        signature = f"{schema}.{name}({identity_args})"
        return self.query(
            f"SELECT COALESCE(to_regprocedure({sql_literal(signature)})::oid::text, '');"
        )

    def role_has_execute(self, oid: str, role: str) -> bool:
        if role.upper() == "PUBLIC":
            value = self.query(
                "SELECT EXISTS ("
                "  SELECT 1 FROM pg_proc p, "
                "  LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a "
                f"  WHERE p.oid={oid}::oid AND a.grantee=0 AND a.privilege_type='EXECUTE'"
                ")::text;"
            )
            return parse_bool(value)
        value = self.query(
            f"SELECT has_function_privilege({sql_literal(role)}, {oid}::oid, 'EXECUTE')::text;"
        )
        return parse_bool(value)

    def verify_functions(self) -> None:
        for item in self.contract.get("functions", []):
            schema = item.get("schema", "public")
            name = item["name"]
            identity_args = item.get("identity_args", "")
            label = f"function {schema}.{name}({identity_args})"
            oid = self.function_oid(schema, name, identity_args)
            if not oid:
                self.fail(f"{label}: missing")
                continue
            row = self.query(
                "SELECT json_build_object("
                "'security_definer', p.prosecdef, "
                "'config', COALESCE(p.proconfig, ARRAY[]::text[]), "
                "'definition', pg_get_functiondef(p.oid)"
                ")::text FROM pg_proc p "
                f"WHERE p.oid={oid}::oid;"
            )
            info = json.loads(row)
            if "security_definer" in item and bool(info.get("security_definer")) != bool(item["security_definer"]):
                self.fail(
                    f"{label}: security_definer={info.get('security_definer')} != expected {item['security_definer']}"
                )
            config = [normalize_sql(v) for v in info.get("config", [])]
            for expected in item.get("config_contains", []):
                if normalize_sql(expected) not in config:
                    self.fail(f"{label}: missing function config {expected!r}")
            self.check_contains(label, info.get("definition") or "", item.get("definition_contains", []))
            for role in item.get("execute_allowed", []):
                if not self.role_has_execute(oid, role):
                    self.fail(f"{label}: {role} must have EXECUTE")
            for role in item.get("execute_denied", []):
                if self.role_has_execute(oid, role):
                    self.fail(f"{label}: {role} unexpectedly has EXECUTE")

    def verify_rls(self) -> None:
        for item in self.contract.get("rls", []):
            schema = item.get("schema", "public")
            table = item["table"]
            row = self.query(
                "SELECT c.relrowsecurity::text FROM pg_class c "
                "JOIN pg_namespace n ON n.oid=c.relnamespace "
                f"WHERE n.nspname={sql_literal(schema)} AND c.relname={sql_literal(table)};"
            )
            label = f"RLS {schema}.{table}"
            if not row:
                self.fail(f"{label}: table missing")
                continue
            expected = bool(item.get("enabled", True))
            if parse_bool(row) != expected:
                self.fail(f"{label}: enabled={parse_bool(row)} != expected {expected}")

    def verify_policies(self) -> None:
        for item in self.contract.get("policies", []):
            schema = item.get("schema", "public")
            table = item["table"]
            name = item["name"]
            row = self.query(
                "SELECT json_build_object("
                "'cmd', cmd, 'roles', roles, 'qual', qual, 'with_check', with_check"
                ")::text FROM pg_policies "
                f"WHERE schemaname={sql_literal(schema)} "
                f"AND tablename={sql_literal(table)} "
                f"AND policyname={sql_literal(name)};"
            )
            label = f"policy {schema}.{table}.{name}"
            if not row:
                self.fail(f"{label}: missing")
                continue
            info = json.loads(row)
            if item.get("command") and str(info.get("cmd", "")).upper() != item["command"].upper():
                self.fail(f"{label}: command={info.get('cmd')} != expected {item['command']}")
            if "roles" in item:
                actual_roles = sorted(str(r) for r in (info.get("roles") or []))
                expected_roles = sorted(item["roles"])
                if actual_roles != expected_roles:
                    self.fail(f"{label}: roles={actual_roles} != expected {expected_roles}")
            if item.get("using_contains"):
                self.check_contains(label + " USING", info.get("qual") or "", item["using_contains"])
            if item.get("check_contains"):
                self.check_contains(label + " CHECK", info.get("with_check") or "", item["check_contains"])

    def verify_table_grants(self) -> None:
        for item in self.contract.get("table_grants", []):
            schema = item.get("schema", "public")
            table = item["table"]
            role = item["role"]
            privilege = item["privilege"].upper()
            expected = bool(item.get("allowed", True))
            target = f"{schema}.{table}"
            value = self.query(
                f"SELECT has_table_privilege({sql_literal(role)}, {sql_literal(target)}, {sql_literal(privilege)})::text;"
            )
            actual = parse_bool(value)
            if actual != expected:
                self.fail(
                    f"table grant {target} {role} {privilege}: allowed={actual} != expected {expected}"
                )

    def run(self) -> int:
        self.verify_indexes()
        self.verify_constraints()
        self.verify_columns()
        self.verify_functions()
        self.verify_rls()
        self.verify_policies()
        self.verify_table_grants()

        if self.failures:
            print("SCHEMA CONTRACT FAILED", file=sys.stderr)
            for failure in self.failures:
                print(f" - {failure}", file=sys.stderr)
            return 1

        counts = {
            key: len(self.contract.get(key, []))
            for key in (
                "indexes",
                "constraints",
                "columns",
                "functions",
                "rls",
                "policies",
                "table_grants",
            )
        }
        print("SCHEMA CONTRACT PASS " + json.dumps(counts, sort_keys=True))
        return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--database-url",
        default=os.environ.get("SCHEMA_DATABASE_URL") or os.environ.get("DATABASE_URL"),
    )
    parser.add_argument("--contract", default="supabase/schema-contract.json")
    args = parser.parse_args()

    if not args.database_url:
        parser.error("--database-url or SCHEMA_DATABASE_URL/DATABASE_URL is required")

    contract_path = Path(args.contract)
    if not contract_path.is_file():
        parser.error(f"contract not found: {contract_path}")

    with contract_path.open("r", encoding="utf-8") as handle:
        contract = json.load(handle)

    try:
        return ContractVerifier(args.database_url, contract).run()
    except (RuntimeError, json.JSONDecodeError) as exc:
        print(f"schema contract verifier error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
