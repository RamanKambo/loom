import type { Model, Routine, Kind } from '../generated/types.js';
import { indexModel, resolveProperty, type ModelIndex } from '../records.js';
import { HASH_NOTICE, toText } from './notice.js';
import type { RenderContext } from './context.js';

export const PESTER_TESTS_FILE = 'Routines.Contract.Tests.ps1';

/**
 * .NET types a PowerShell parameter's type constraint may resolve to for each
 * kind. Compared against TypeName.GetReflectionType().FullName, so accelerators
 * resolve first: [int] -> System.Int32, [long] -> System.Int64, [float] ->
 * System.Single, [switch] -> System.Management.Automation.SwitchParameter.
 */
const POWERSHELL_TYPES: Readonly<Record<Kind, readonly string[]>> = {
  string: ['System.String'],
  enum: ['System.String'],
  uuid: ['System.Guid', 'System.String'],
  integer: ['System.Int32', 'System.Int64'],
  number: ['System.Double', 'System.Single'],
  decimal: ['System.Decimal'],
  boolean: ['System.Boolean', 'System.Management.Automation.SwitchParameter'],
  date: ['System.DateTime'],
  datetime: ['System.DateTime', 'System.DateTimeOffset'],
  ref: ['System.Collections.Hashtable', 'System.Management.Automation.PSObject', 'System.Object'],
  array: ['System.Object[]', 'System.String[]', 'System.Int32[]', 'System.Int64[]'],
  union: ['System.Collections.Hashtable', 'System.Management.Automation.PSObject', 'System.Object'],
};

/** A PowerShell single-quoted literal; the typographic single quotes PowerShell also treats as quotes are doubled too. */
function q(s: string): string {
  return `'${s.replace(/['‘’‚‛]/g, '$&$&')}'`;
}

const list = (values: readonly string[]): string => `@(${values.map(q).join(', ')})`;

// Helpers run in the Run phase (top-level BeforeAll), never at discovery.
const HELPERS = [
  'BeforeAll {',
  '    function Read-LoomScript {',
  '        param([string] $Path)',
  '        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {',
  '            return [pscustomobject]@{ Exists = $false; Errors = @(); Parameters = @() }',
  '        }',
  '        $tokens = $null',
  '        $errors = $null',
  '        $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref] $tokens, [ref] $errors)',
  '        $parameters = @()',
  '        if ($null -ne $ast.ParamBlock) { $parameters = @($ast.ParamBlock.Parameters) }',
  '        $outputs = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.ConvertExpressionAst] -and $node.Type.TypeName.FullName -eq "pscustomobject" }, $true) | ForEach-Object {',
  '            $table = $_.Find({ param($node) $node -is [System.Management.Automation.Language.HashtableAst] }, $true)',
  '            if ($null -ne $table) { @($table.KeyValuePairs | ForEach-Object { [string] $_.Item1.SafeGetValue() }) -join "|" }',
  '        })',
  '        [pscustomobject]@{ Exists = $true; Errors = @($errors); Parameters = $parameters; Outputs = $outputs }',
  '    }',
  '',
  '    function Get-LoomAttribute {',
  '        param($Parameter, [type] $AttributeType)',
  '        @($Parameter.Attributes | Where-Object {',
  '            $_ -is [System.Management.Automation.Language.AttributeAst] -and',
  '            $_.TypeName.GetReflectionAttributeType() -eq $AttributeType',
  '        })',
  '    }',
  '',
  '    function Test-LoomMandatory {',
  '        param($Parameter)',
  '        foreach ($attribute in (Get-LoomAttribute -Parameter $Parameter -AttributeType ([System.Management.Automation.ParameterAttribute]))) {',
  '            foreach ($argument in $attribute.NamedArguments) {',
  "                if ($argument.ArgumentName -ne 'Mandatory') { continue }",
  '                if ($argument.ExpressionOmitted) { return $true }',
  '                try { return [bool] $argument.Argument.SafeGetValue() } catch { return $false }',
  '            }',
  '        }',
  '        return $false',
  '    }',
  '',
  '    function Get-LoomParameterType {',
  '        param($Parameter)',
  '        $constraint = @($Parameter.Attributes | Where-Object { $_ -is [System.Management.Automation.Language.TypeConstraintAst] }) | Select-Object -First 1',
  "        if ($null -eq $constraint) { return '' }",
  '        $type = $constraint.TypeName.GetReflectionType()',
  '        if ($null -ne $type) { return $type.FullName }',
  '        return $constraint.TypeName.FullName',
  '    }',
  '',
  '    function Get-LoomValidateSet {',
  '        param($Parameter)',
  '        foreach ($attribute in (Get-LoomAttribute -Parameter $Parameter -AttributeType ([System.Management.Automation.ValidateSetAttribute]))) {',
  '            return @($attribute.PositionalArguments | ForEach-Object { [string] $_.SafeGetValue() })',
  '        }',
  '        return @()',
  '    }',
  '}',
];

function orderTest(r: Routine): string[] {
  const names = r.params.map((p) => p.name);
  if (r.parameterPassing === 'positional') {
    return [
      `    It ${q(names.length ? `declares the parameters ${names.join(', ')} in this order` : 'declares no parameters')} {`,
      `        (@($routine.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }) -join ', ') | Should -Be ${q(names.join(', '))}`,
      '    }',
    ];
  }
  return [
    `    It ${q(names.length ? `declares exactly the parameters ${names.join(', ')}, in any order` : 'declares no parameters')} {`,
    '        $actual = @($routine.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })',
    `        $actual | Should -HaveCount ${names.length}`,
    ...(names.length ? [`        Compare-Object -ReferenceObject ${list(names)} -DifferenceObject $actual | Should -BeNullOrEmpty`] : []),
    '    }',
  ];
}

const describeTitle = (r: Routine): string => q(`Routine ${r.id} (${r.host}, version ${r.version}, ${r.parameterPassing} parameters)`);

function routineBlock(index: ModelIndex, r: Routine, source: string): string[] {
  const lines: string[] = [
    `Describe ${describeTitle(r)} {`,
    '    BeforeAll {',
    `        $path = Join-Path -Path $RoutineRoot -ChildPath ${q(source)}`,
    '        $routine = Read-LoomScript -Path $path',
    '        $byName = @{}',
    '        foreach ($parameter in $routine.Parameters) { $byName[$parameter.Name.VariablePath.UserPath] = $parameter }',
    '    }',
    '',
    `    It ${q(`has its source file ${source}`)} {`,
    `        $routine.Exists | Should -BeTrue -Because ${q(`the contract declares source ${source} under the routine root`)}`,
    '    }',
    '',
    "    It 'parses without errors' {",
    '        $routine.Exists | Should -BeTrue',
    '        $routine.Errors | Should -HaveCount 0',
    '    }',
    '',
    ...orderTest(r),
  ];
  for (const p of r.params) {
    const present = `        $byName.ContainsKey(${q(p.name)}) | Should -BeTrue -Because ${q(`the contract declares parameter ${p.name}`)}`;
    lines.push(
      '',
      `    It ${q(`parameter ${p.name} is ${p.required ? 'mandatory' : 'not mandatory'}`)} {`,
      present,
      `        Test-LoomMandatory -Parameter $byName[${q(p.name)}] | Should -Be${p.required ? 'True' : 'False'}`,
      '    }',
      '',
      `    It ${q(`parameter ${p.name} is typed for kind ${p.kind}`)} {`,
      present,
      `        Get-LoomParameterType -Parameter $byName[${q(p.name)}] | Should -BeIn ${list(POWERSHELL_TYPES[p.kind])}`,
      '    }',
    );
    lines.push('', `    It ${q(`parameter ${p.name} ${p.nullable ? 'permits' : 'rejects'} a present null`)} {`, present,
      `        $allowNull = @(Get-LoomAttribute -Parameter $byName[${q(p.name)}] -AttributeType ([System.Management.Automation.AllowNullAttribute])).Count -gt 0`,
      `        $rejectNull = @(Get-LoomAttribute -Parameter $byName[${q(p.name)}] -AttributeType ([System.Management.Automation.ValidateNotNullAttribute])).Count -gt 0 -or @(Get-LoomAttribute -Parameter $byName[${q(p.name)}] -AttributeType ([System.Management.Automation.ValidateNotNullOrEmptyAttribute])).Count -gt 0`,
      p.nullable ? '        ($allowNull -and -not $rejectNull) | Should -BeTrue' : `        ($rejectNull -or ((Test-LoomMandatory -Parameter $byName[${q(p.name)}]) -and -not $allowNull)) | Should -BeTrue`, '    }');
    if (p.kind === 'enum' && p.binds !== undefined) {
      const bound = resolveProperty(index, p.binds)?.property;
      if (bound && bound.kind === 'enum' && bound.enumValues) {
        lines.push(
          '',
          `    It ${q(`parameter ${p.name} accepts exactly the values of ${p.binds}`)} {`,
          present,
          `        $actual = @(Get-LoomValidateSet -Parameter $byName[${q(p.name)}])`,
          `        $actual | Should -Not -BeNullOrEmpty -Because ${q(`the contract binds ${p.name} to the enum ${p.binds}`)}`,
          `        Compare-Object -ReferenceObject ${list(bound.enumValues)} -DifferenceObject $actual | Should -BeNullOrEmpty`,
          '    }',
        );
      }
    }
  }
  if (r.resultSet.length) {
    lines.push('', `    It ${q(`declares output object properties ${r.resultSet.map((p) => p.name).join(', ')}`)} {`, `        $routine.Outputs | Should -Not -BeNullOrEmpty -Because 'the result contract must have an explicit output object declaration'`, `        foreach ($output in $routine.Outputs) {`, `            Compare-Object -ReferenceObject ${list(r.resultSet.map((p) => p.name))} -DifferenceObject @($output.Split([char]124)) | Should -BeNullOrEmpty`, '        }', '    }');
  }
  lines.push('}');
  return lines;
}

/**
 * One Pester test file per component for its runbook and function routines
 * that declare a source. Each script is parsed, never executed: the checks
 * read the param block (names, and their order under positional passing;
 * Mandatory; type constraint; ValidateSet for enum params bound to an enum
 * property), null validation declarations and explicit output object keys.
 * No test establishes business behavior or dynamic output paths.
 */
export function projectPesterContractTests(model: Model, ctx: RenderContext): Record<string, string> {
  const index = indexModel(model);
  const lines: string[] = [
    HASH_NOTICE,
    `# Loom conformance checks for the runbook and function routines of ${ctx.component ? `component ${ctx.component}` : 'every component'} (Pester 5; also runs under Pester 6).`,
    "# Each routine's script is parsed, never executed: checks read parameters and explicit output declarations.",
    "# Explicit pscustomobject output declarations are checked by property name; dynamic output and business behavior are not qualified.",
    "# Run: Invoke-Pester -Container (New-PesterContainer -Path ./Routines.Contract.Tests.ps1 -Data @{ RoutineRoot = '<repository root>' })",
    'param(',
    '    [string] $RoutineRoot = (Get-Location).Path',
    ')',
    '',
    ...HELPERS,
  ];
  for (const r of model.routines) {
    if (r.host !== 'runbook' && r.host !== 'function') continue;
    if (ctx.component !== undefined && r.owner !== ctx.component) continue;
    for (const p of [...r.params, ...r.resultSet]) {
      if (p.binds && resolveProperty(index, p.binds)?.type.externalSchema) ctx.unsupported('type.externalSchema', { kind: 'routine', id: r.id }, `routine '${r.id}' member '${p.name}' binds an externally authored shape that AST parameter checks cannot qualify`);
    }
    lines.push('');
    if (r.source === undefined) {
      lines.push(`# Routine ${r.id} (${r.host}) declares no source, so its contract is not checked.`);
      continue;
    }
    ctx.covered({ kind: 'routine', id: r.id }, PESTER_TESTS_FILE, `Describe ${describeTitle(r)}`);
    lines.push(...routineBlock(index, r, r.source));
  }
  return { [PESTER_TESTS_FILE]: toText(lines) };
}
