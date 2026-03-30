export interface BanxicoI {
    bmx:{
        series: {
            idSerie: string;
            titulo: string,
            datos: {
                fecha: string;
                dato: string
            }[]
        }[]
    }
}