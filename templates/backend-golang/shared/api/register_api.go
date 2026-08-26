package api

import (
	"base-be-golang/shared/base"

	"gorm.io/gorm"
)

func (a *Api) Register(r func(dbConn *gorm.DB, port base.Port, controller base.BaseController) Router) {
	a.routers = append(a.routers,
		r(a.db,
			base.NewPort(a.db, a.cache, a.reZero),
			base.NewBaseController(a.db, a.cache),
		))
}
