{{/*
Application base name. Defaults to the helm release name; override with
.Values.nameOverride.
*/}}
{{- define "app.fullname" -}}
{{- default .Release.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Per-service resource name: "<app>-<service>". Truncated to 63 chars
(K8s limit). Expects (dict "root" $ "service" $svc).
*/}}
{{- define "app.serviceFullname" -}}
{{- $appName := default .root.Release.Name .root.Values.nameOverride -}}
{{- printf "%s-%s" ($appName | trunc 50 | trimSuffix "-") .service.name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Top-level labels (no per-service component label). Call with a scope where
.Release and .Values are available — e.g. `{{ include "app.labels" . }}`.
*/}}
{{- define "app.labels" -}}
app.kubernetes.io/name: {{ default .Release.Name .Values.nameOverride }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/*
Per-service labels — adds component. Expects (dict "root" $ "service" $svc).
*/}}
{{- define "app.serviceLabels" -}}
app.kubernetes.io/name: {{ default .root.Release.Name .root.Values.nameOverride }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/component: {{ .service.name }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" }}
{{- end -}}

{{/*
Selector labels (must be stable across upgrades — never include chart/version).
*/}}
{{- define "app.selectorLabels" -}}
app.kubernetes.io/name: {{ default .root.Release.Name .root.Values.nameOverride }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .service.name }}
{{- end -}}

{{/*
Service account name used by deployments and optional RBAC.
*/}}
{{- define "app.serviceAccountName" -}}
{{- if .Values.serviceAccount.name -}}
{{- .Values.serviceAccount.name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "app.fullname" . -}}
{{- end -}}
{{- end -}}

{{/*
ClusterRole name used when .Values.rbac.create is enabled.
*/}}
{{- define "app.rbacName" -}}
{{- if .Values.rbac.clusterRoleName -}}
{{- .Values.rbac.clusterRoleName | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "app.fullname" . -}}
{{- end -}}
{{- end -}}
