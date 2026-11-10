{{- define "ronin.fullname" -}}
{{- printf "%s" .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "ronin.labels" -}}
app.kubernetes.io/name: ronin-rush
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "ronin.selector" -}}
app.kubernetes.io/name: ronin-rush
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ronin.image" -}}
{{- $tag := .root.Values.image.tag | default .root.Chart.AppVersion -}}
{{- printf "%s/ronin-rush-%s:%s" .root.Values.image.registry .component $tag -}}
{{- end -}}

{{- define "ronin.secretName" -}}
{{- .Values.secrets.existingSecret | default (printf "%s-secrets" (include "ronin.fullname" .)) -}}
{{- end -}}
