import type { ItemShape, Model, Property, TypeDef } from '../generated/types.js';
import { indexModel, type ModelIndex } from '../records.js';
import { MARKDOWN_NOTICE, SLASH_NOTICE, toText } from './notice.js';
import { sampleObject } from './samples.js';
import { pascal, type RenderContext } from './context.js';

export const CSHARP_TESTS_FILE = 'ContractTests.cs';
export const CSHARP_PROJECT_FILE = 'ContractTests.csproj';

/** Pinned test-host packages; the profile's tooling records the SDK, these record the test framework. */
const PACKAGES: ReadonlyArray<[string, string]> = [
  ['Microsoft.NET.Test.Sdk', '18.10.0'],
  ['xunit', '2.9.3'],
  ['xunit.runner.visualstudio', '3.1.5'],
];

const CLR: Readonly<Partial<Record<Property['kind'], string>>> = {
  string: 'string',
  integer: 'long',
  number: 'double',
  decimal: 'decimal',
  boolean: 'bool',
  date: 'DateOnly',
  datetime: 'DateTimeOffset',
  uuid: 'Guid',
};

const str = (s: string): string => JSON.stringify(s);

/** The module (namespace and assembly name) of a component's csharp implementation. */
export function csharpModule(model: Model, component: string): string | undefined {
  return model.components.find((c) => c.id === component)?.implementations?.find((i) => i.language === 'csharp')?.module;
}

/** The C# expression asserting a property's CLR type, or null when the shape cannot be expressed. */
function typeAssertion(shape: Pick<Property, 'kind' | 'ref' | 'items'>, member: string): string | null {
  switch (shape.kind) {
    case 'enum':
      return `Loom.EnumOrString(${member});`;
    case 'ref':
      return `Loom.Named(${member}, ${str(pascal(shape.ref ?? ''))});`;
    case 'array': {
      const item = shape.items as ItemShape | undefined;
      if (!item) return null;
      if (item.kind === 'ref') return `Loom.ListOfNamed(${member}, ${str(pascal(item.ref ?? ''))});`;
      if (item.kind === 'enum') return `Loom.ListOfEnumOrString(${member});`;
      const clr = CLR[item.kind];
      return clr ? `Loom.ListOf(${member}, typeof(${clr}));` : null;
    }
    default: {
      const clr = CLR[shape.kind];
      return clr ? `Loom.ClrType(${member}, typeof(${clr}));` : null;
    }
  }
}

function hasUnion(shape: Pick<Property, 'kind' | 'items'>): boolean {
  return shape.kind === 'union' || (shape.kind === 'array' && shape.items !== undefined && hasUnion(shape.items));
}

const HELPERS = [
  'internal static class Loom',
  '{',
  '    internal static readonly Assembly Implementation = Assembly.Load(new AssemblyName(Module.Name));',
  '    internal static readonly JsonSerializerOptions Json = Options();',
  '',
  '    // The implementation may supply its serializer options as a public static',
  '    // ContractJson.Options property; the tests then serialize exactly as it does.',
  '    private static JsonSerializerOptions Options()',
  '    {',
  '        var holder = Implementation.GetType(Module.Name + ".ContractJson");',
  '        var configured = holder?.GetProperty("Options", BindingFlags.Public | BindingFlags.Static)?.GetValue(null) as JsonSerializerOptions;',
  '        var options = configured is null ? new JsonSerializerOptions(JsonSerializerDefaults.Web) : new JsonSerializerOptions(configured);',
  '        options.TypeInfoResolver ??= new DefaultJsonTypeInfoResolver();',
  '        options.MakeReadOnly();',
  '        return options;',
  '    }',
  '',
  '    internal static Type TypeNamed(string name)',
  '    {',
  '        var type = Implementation.GetType(Module.Name + "." + name);',
  '        Assert.True(type is not null, $"the implementation assembly {Module.Name} declares no public type {Module.Name}.{name}");',
  '        return type!;',
  '    }',
  '',
  '    internal static PropertyInfo Property(Type type, string name)',
  '    {',
  '        var property = type.GetProperty(name, BindingFlags.Public | BindingFlags.Instance);',
  '        Assert.True(property is not null, $"{type.Name} declares no public property {name}");',
  '        return property!;',
  '    }',
  '',
  '    private static Type Unwrapped(PropertyInfo p) => System.Nullable.GetUnderlyingType(p.PropertyType) ?? p.PropertyType;',
  '',
  '    internal static void ClrType(PropertyInfo p, Type expected) =>',
  '        Assert.True(Unwrapped(p) == expected, $"{p.DeclaringType!.Name}.{p.Name} is {Unwrapped(p).FullName}, but the contract declares {expected.FullName}");',
  '',
  '    internal static void EnumOrString(PropertyInfo p) =>',
  '        Assert.True(Unwrapped(p) == typeof(string) || Unwrapped(p).IsEnum, $"{p.DeclaringType!.Name}.{p.Name} is {Unwrapped(p).FullName}, but an enum member is a string or a C# enum");',
  '',
  '    internal static void Named(PropertyInfo p, string typeName) =>',
  '        Assert.True(Unwrapped(p).Name == typeName, $"{p.DeclaringType!.Name}.{p.Name} is {Unwrapped(p).FullName}, but the contract references {typeName}");',
  '',
  '    private static Type? ListItem(PropertyInfo p) =>',
  '        new[] { p.PropertyType }.Concat(p.PropertyType.GetInterfaces())',
  '            .FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IReadOnlyList<>))?.GetGenericArguments()[0];',
  '',
  '    internal static void ListOf(PropertyInfo p, Type item) =>',
  '        Assert.True(ListItem(p) == item, $"{p.DeclaringType!.Name}.{p.Name} is {p.PropertyType.FullName}, but the contract declares IReadOnlyList<{item.FullName}>");',
  '',
  '    internal static void ListOfNamed(PropertyInfo p, string typeName) =>',
  '        Assert.True(ListItem(p)?.Name == typeName, $"{p.DeclaringType!.Name}.{p.Name} is {p.PropertyType.FullName}, but the contract declares a list of {typeName}");',
  '',
  '    internal static void ListOfEnumOrString(PropertyInfo p) =>',
  '        Assert.True(ListItem(p) is { } item && (item == typeof(string) || item.IsEnum), $"{p.DeclaringType!.Name}.{p.Name} is {p.PropertyType.FullName}, but the contract declares a list of enum values");',
  '',
  '    internal static void Nullable(PropertyInfo p, bool nullable)',
  '    {',
  '        var state = new NullabilityInfoContext().Create(p).ReadState;',
  '        Assert.True(nullable ? state == NullabilityState.Nullable : state == NullabilityState.NotNull,',
  '            $"{p.DeclaringType!.Name}.{p.Name} reads as {state}, but the contract declares it {(nullable ? "nullable or optional" : "required and not nullable")}");',
  '    }',
  '',
  '    internal static void Immutable(PropertyInfo p)',
  '    {',
  '        var setter = p.SetMethod;',
  '        if (setter is null || !setter.IsPublic) return;',
  '        var initOnly = setter.ReturnParameter.GetRequiredCustomModifiers().Any(m => m.FullName == "System.Runtime.CompilerServices.IsExternalInit");',
  '        Assert.True(initOnly, $"{p.DeclaringType!.Name}.{p.Name} has a public setter, but the contract declares it immutable (init-only or get-only)");',
  '    }',
  '',
  '    internal static void Required(PropertyInfo p, bool required)',
  '    {',
  '        var declared = p.GetCustomAttributes(true).Any(a => a.GetType().FullName == "System.Runtime.CompilerServices.RequiredMemberAttribute" || a is JsonRequiredAttribute);',
  '        Assert.True(declared == required, $"{p.DeclaringType!.Name}.{p.Name} is {(declared ? "" : "not ")}required, but the contract declares it {(required ? "required" : "optional")}");',
  '    }',
  '',
  '    internal static void JsonMember(Type type, string clr, string json)',
  '    {',
  '        var info = Json.GetTypeInfo(type).Properties.FirstOrDefault(x => x.AttributeProvider is PropertyInfo pi && pi.Name == clr);',
  '        Assert.True(info is not null, $"{type.Name}.{clr} is not serialized");',
  '        Assert.True(info!.Name == json, $"{type.Name}.{clr} serializes as \'{info.Name}\', but the contract names the member \'{json}\'");',
  '    }',
  '',
  '    private static JsonNode? Back(Type type, string json) =>',
  '        JsonSerializer.SerializeToNode(JsonSerializer.Deserialize(json, type, Json), type, Json);',
  '',
  '    internal static void RoundTrips(Type type, string json)',
  '    {',
  '        var back = Back(type, json);',
  '        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(json), back), $"{type.Name} did not round-trip: sent {json}, got {back?.ToJsonString()}");',
  '    }',
  '',
  '    internal static void KeepsText(Type type, string json, string member)',
  '    {',
  '        var sent = JsonNode.Parse(json)![member]?.ToJsonString();',
  '        var got = Back(type, json)?[member]?.ToJsonString();',
  '        Assert.True(sent == got, $"{type.Name} member \'{member}\' was sent as {sent} and came back as {got}");',
  '    }',
  '',
  '    internal static void RejectsMissing(Type type, string json, string member)',
  '    {',
  '        var payload = JsonNode.Parse(json)!.AsObject();',
  '        payload.Remove(member);',
  '        Assert.ThrowsAny<Exception>(() => JsonSerializer.Deserialize(payload.ToJsonString(), type, Json));',
  '    }',
  '',
  '    internal static void RejectsValue(Type type, string json, string member, string value)',
  '    {',
  '        var payload = JsonNode.Parse(json)!.AsObject();',
  '        payload[member] = value;',
  '        Assert.ThrowsAny<Exception>(() => JsonSerializer.Deserialize(payload.ToJsonString(), type, Json));',
  '    }',
  '}',
];

function typeClass(index: ModelIndex, t: TypeDef, ctx: RenderContext): string[] {
  const cls = pascal(t.id);
  const sample = JSON.stringify(sampleObject(index, t));
  const L: string[] = [
    '',
    `/// <summary>Contract of type '${t.id}' (${t.representation}, version ${t.version}).</summary>`,
    `public sealed class ${cls}Contract`,
    '{',
    `    private const string Sample = """${sample}""";`,
    `    private static Type T => Loom.TypeNamed(${str(cls)});`,
    '',
    `    [Fact] public void ${cls}_is_a_public_type() => Assert.True(T.IsPublic, "${cls} is not public");`,
  ];
  ctx.covered({ kind: 'type', id: t.id }, CSHARP_TESTS_FILE, `Loom.TypeNamed(${str(cls)})`);
  let roundTrips = true;
  for (const p of t.properties) {
    const ref = { kind: 'property' as const, id: `${t.id}.${p.name}` };
    if (hasUnion(p)) {
      ctx.unsupported('type.union', { kind: 'type', id: t.id }, `property '${t.id}.${p.name}' is a union, which this profile does not serialize`);
      roundTrips = false;
      continue;
    }
    const clr = pascal(p.name);
    const member = `Loom.Property(T, ${str(clr)})`;
    const assertion = typeAssertion(p, member);
    L.push('');
    if (assertion) L.push(`    [Fact] public void ${clr}_has_the_declared_type() => ${assertion}`);
    L.push(`    [Fact] public void ${clr}_is_${p.nullable || !p.required ? 'nullable' : 'not_nullable'}() => Loom.Nullable(${member}, ${p.nullable || !p.required});`);
    L.push(`    [Fact] public void ${clr}_is_${p.required ? 'required' : 'optional'}() => Loom.Required(${member}, ${p.required});`);
    if (p.immutable) L.push(`    [Fact] public void ${clr}_is_immutable() => Loom.Immutable(${member});`);
    L.push(`    [Fact] public void ${clr}_serializes_as_${p.name}() => Loom.JsonMember(T, ${str(clr)}, ${str(p.name)});`);
    if (p.required) L.push(`    [Fact] public void A_payload_without_${p.name}_is_rejected() => Loom.RejectsMissing(T, Sample, ${str(p.name)});`);
    if (p.kind === 'decimal') L.push(`    [Fact] public void ${clr}_keeps_its_exact_decimal_text() => Loom.KeepsText(T, Sample, ${str(p.name)});`);
    if (p.kind === 'enum' && p.unknownEnumPolicy === 'reject') {
      L.push(`    [Fact] public void ${clr}_outside_its_value_set_is_rejected() => Loom.RejectsValue(T, Sample, ${str(p.name)}, "loom-value-outside-the-set");`);
    }
    ctx.covered(ref, CSHARP_TESTS_FILE, member);
  }
  if (roundTrips) L.push('', `    [Fact] public void A_conforming_payload_round_trips() => Loom.RoundTrips(T, Sample);`);
  L.push('}');
  return L;
}

/**
 * xUnit conformance tests for one component's csharp implementation. Every
 * check reads the implementation's real public types by reflection and its
 * real System.Text.Json behavior; nothing in the generated code implements a
 * type, so a missing type fails its own tests instead of the build.
 */
export function projectCsharpContractTests(model: Model, ctx: RenderContext): Record<string, string> {
  const component = ctx.component as string;
  const module = csharpModule(model, component) as string;
  const index = indexModel(model);
  const types = model.types.filter((t) => t.owner === component);
  const tests = [
    SLASH_NOTICE,
    `// Conformance tests of component '${component}' against the public types of the implementation assembly '${module}'.`,
    '// Each declared type is checked for presence, member types, nullability, required and immutable members,',
    '// JSON member names and a serializer round trip. Business behavior is never generated or asserted.',
    '#nullable enable',
    'using System;',
    'using System.Collections.Generic;',
    'using System.Linq;',
    'using System.Reflection;',
    'using System.Text.Json;',
    'using System.Text.Json.Nodes;',
    'using System.Text.Json.Serialization;',
    'using System.Text.Json.Serialization.Metadata;',
    'using Xunit;',
    '',
    `namespace ${module}.ContractTests;`,
    '',
    'internal static class Module',
    '{',
    `    internal const string Name = ${str(module)};`,
    '}',
    '',
    ...HELPERS,
  ];
  for (const t of types) tests.push(...typeClass(index, t, ctx));
  const project = [
    MARKDOWN_NOTICE,
    `<!-- xUnit conformance tests of component '${component}'. Build with -p:LoomImplementationProject=<path of the implementation project>. -->`,
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    '    <TargetFramework>net8.0</TargetFramework>',
    '    <Nullable>enable</Nullable>',
    '    <ImplicitUsings>disable</ImplicitUsings>',
    '    <IsPackable>false</IsPackable>',
    '    <IsTestProject>true</IsTestProject>',
    `    <AssemblyName>${module}.ContractTests</AssemblyName>`,
    `    <RootNamespace>${module}.ContractTests</RootNamespace>`,
    '  </PropertyGroup>',
    '  <ItemGroup>',
    ...PACKAGES.map(([id, version]) => `    <PackageReference Include="${id}" Version="${version}" />`),
    '  </ItemGroup>',
    '  <ItemGroup>',
    '    <ProjectReference Include="$(LoomImplementationProject)" />',
    '  </ItemGroup>',
    '  <Target Name="LoomRequireImplementation" BeforeTargets="ResolveProjectReferences" Condition="\'$(LoomImplementationProject)\' == \'\'">',
    `    <Error Text="Set LoomImplementationProject to the project that implements ${module}." />`,
    '  </Target>',
    '</Project>',
  ];
  return { [CSHARP_TESTS_FILE]: toText(tests), [CSHARP_PROJECT_FILE]: toText(project) };
}
