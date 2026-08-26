//go:generate mockery --all --inpackage --case snake

package mapper

import (
	"base-be-golang/pkg/localize"
)

type Mapper struct {
	localizer localize.Language
}

func NewMapper() Mapper {
	return Mapper{
		localizer: localize.NewLanguage("resource/message"),
	}
}
